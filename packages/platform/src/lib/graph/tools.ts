import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { PlatformContext } from "../context.js";
import { cbmCli, graphUnavailable } from "./cbm-client.js";
import { readCbmMapping, type CbmProjectMapping } from "./init.js";
import {
  escapeRegExp,
  flattenGroups,
  isIdentifierQuery,
  parseProjectPage,
  type Hit,
} from "./parse.js";

export type GraphState = "ready" | "degraded" | "missing";

export type GraphSearchIn = { query: string; path?: string };
export type GraphSearchOut = { hits: Hit[]; truncated: boolean; graph: GraphState };

export type GraphSymbolIn = { name: string };
export type GraphSymbolOut = {
  definitions: Hit[];
  refs: { name: string; path: string }[];
  graph: GraphState;
};

export type GraphImpactIn = { path?: string; symbol?: string };
export type GraphImpactOut = {
  callers: Hit[];
  dependents: Hit[];
  truncated: boolean;
  graph: GraphState;
};

const SEARCH_LIMIT = 15;
const DEF_CAP = 10;
const REF_CAP = 10;
const IMPACT_CAP = 20;
const QUERY_TIMEOUT_MS = 60_000;
const DEF_LABELS = new Set(["Function", "Method", "Class", "Interface"]);

function mappingGraph(mapping: CbmProjectMapping | undefined): GraphState {
  if (!mapping) {
    return "missing";
  }
  return mapping.last_status === "degraded" ? "degraded" : "ready";
}

function realOrRaw(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function resolveProject(ctx: PlatformContext): Promise<{ name: string; graph: GraphState }> {
  const mapped = readCbmMapping(ctx.paths.cbmProjectFile);
  if (mapped?.cbm_project) {
    return { name: mapped.cbm_project, graph: mappingGraph(mapped) };
  }
  const body = await cbmCli(
    ctx,
    "list_projects",
    { "include-details": true, limit: 100, offset: 0 },
    { timeoutMs: QUERY_TIMEOUT_MS },
  );
  const page = parseProjectPage(body);
  const match = page.projects.find((p) => realOrRaw(p.root_path) === ctx.repoPath);
  if (!match) {
    throw graphUnavailable("Graph mapping missing", "run devkit init");
  }
  return { name: match.name, graph: "ready" };
}

function gitDiffNames(ctx: PlatformContext): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function capHits(hits: Hit[], n: number): { hits: Hit[]; truncated: boolean } {
  return { hits: hits.slice(0, n), truncated: hits.length > n };
}

export async function graphSearch(ctx: PlatformContext, q: GraphSearchIn): Promise<GraphSearchOut> {
  const { name: project, graph } = await resolveProject(ctx);
  const flags: Record<string, string | number | boolean | undefined> = {
    project,
    format: "json",
    limit: SEARCH_LIMIT,
  };
  if (isIdentifierQuery(q.query)) {
    flags["name-pattern"] = `.*${escapeRegExp(q.query)}.*`;
  } else {
    flags.query = q.query;
  }
  if (q.path) {
    flags["file-pattern"] = q.path;
  }
  const body = await cbmCli(ctx, "search_graph", flags, { timeoutMs: QUERY_TIMEOUT_MS });
  const hits = flattenGroups(body).slice(0, SEARCH_LIMIT);
  const hasMore = Boolean(
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { has_more?: unknown }).has_more === true,
  );
  return { hits, truncated: hasMore || hits.length === SEARCH_LIMIT, graph };
}

export async function graphSymbol(ctx: PlatformContext, q: GraphSymbolIn): Promise<GraphSymbolOut> {
  const { name: project, graph } = await resolveProject(ctx);
  const body = await cbmCli(
    ctx,
    "search_graph",
    {
      project,
      format: "json",
      limit: SEARCH_LIMIT,
      "name-pattern": `^${escapeRegExp(q.name)}($|\\.)`,
    },
    { timeoutMs: QUERY_TIMEOUT_MS },
  );
  const hits = flattenGroups(body);
  const definitions = hits.slice(0, DEF_CAP);
  const top = hits.find((h) => DEF_LABELS.has(h.label)) ?? hits[0];
  const qnHits = hits.filter((h) => h.qn === top?.qn);
  if (top?.qn && qnHits.length === 1) {
    try {
      await cbmCli(
        ctx,
        "get_code_snippet",
        { project, "qualified-name": top.qn },
        { timeoutMs: QUERY_TIMEOUT_MS },
      );
    } catch {
      // snippet is optional
    }
  }
  const refs: { name: string; path: string }[] = [];
  if (top?.name) {
    try {
      const traced = await cbmCli(
        ctx,
        "trace_path",
        {
          project,
          "function-name": top.name,
          direction: "inbound",
          depth: 2,
          format: "json",
        },
        { timeoutMs: QUERY_TIMEOUT_MS },
      );
      for (const h of flattenGroups(traced, "callers")) {
        if (refs.length >= REF_CAP) {
          break;
        }
        refs.push({ name: h.name, path: h.path });
      }
    } catch {
      // refs are optional
    }
  }
  return { definitions, refs, graph };
}

export async function graphImpact(ctx: PlatformContext, q: GraphImpactIn): Promise<GraphImpactOut> {
  if (!q.path && !q.symbol) {
    throw graphUnavailable("graph_impact needs path or symbol");
  }
  const { name: project, graph } = await resolveProject(ctx);
  let truncated = false;
  const callers: Hit[] = [];
  const dependents: Hit[] = [];

  if (q.symbol) {
    const traced = await cbmCli(
      ctx,
      "trace_path",
      {
        project,
        "function-name": q.symbol,
        direction: "inbound",
        depth: 3,
        format: "json",
      },
      { timeoutMs: QUERY_TIMEOUT_MS },
    );
    callers.push(...flattenGroups(traced, "callers"));
    dependents.push(...flattenGroups(traced, "callees"));
    if (
      traced &&
      typeof traced === "object" &&
      !Array.isArray(traced) &&
      ((traced as { truncated?: unknown }).truncated === true ||
        (traced as { next?: unknown }).next)
    ) {
      truncated = true;
    }
  } else if (q.path) {
    const found = await cbmCli(
      ctx,
      "search_graph",
      {
        project,
        format: "json",
        limit: SEARCH_LIMIT,
        "file-pattern": q.path,
      },
      { timeoutMs: QUERY_TIMEOUT_MS },
    );
    const symbols = flattenGroups(found)
      .filter((h) => DEF_LABELS.has(h.label) || h.name)
      .slice(0, 5);
    for (const sym of symbols) {
      try {
        const traced = await cbmCli(
          ctx,
          "trace_path",
          {
            project,
            "function-name": sym.name,
            direction: "inbound",
            depth: 2,
            format: "json",
          },
          { timeoutMs: QUERY_TIMEOUT_MS },
        );
        callers.push(...flattenGroups(traced, "callers"));
        dependents.push(...flattenGroups(traced, "callees"));
        if (
          traced &&
          typeof traced === "object" &&
          !Array.isArray(traced) &&
          ((traced as { truncated?: unknown }).truncated === true ||
            (traced as { next?: unknown }).next)
        ) {
          truncated = true;
        }
      } catch {
        // skip one symbol
      }
    }
    if (gitDiffNames(ctx).length > 0) {
      try {
        const changed = await cbmCli(
          ctx,
          "detect_changes",
          { project, format: "json" },
          { timeoutMs: QUERY_TIMEOUT_MS },
        );
        dependents.push(...flattenGroups(changed, "impacted"));
        if (
          changed &&
          typeof changed === "object" &&
          !Array.isArray(changed) &&
          (changed as { truncated?: unknown }).truncated === true
        ) {
          truncated = true;
        }
      } catch {
        // detect_changes is extra
      }
    }
  }

  const c = capHits(callers, IMPACT_CAP);
  const d = capHits(dependents, IMPACT_CAP);
  return {
    callers: c.hits,
    dependents: d.hits,
    truncated: truncated || c.truncated || d.truncated,
    graph,
  };
}
