import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { IndexMode } from "../config.js";
import type { PlatformContext } from "../context.js";
import { writeFileAtomicSync } from "../fs-atomic.js";
import { cbmCli, discoverCbmBinary, graphUnavailable, missingCbmInitError } from "./cbm-client.js";
import { confirmPinnedFetch, fetchPinnedCbm, type FetchCbmOpts } from "./cbm-fetch.js";
import { cbmBinaryName, selectCbmAsset } from "./cbm-release.js";
import { parseIndexBody, parseProjectPage, type CbmProjectRow } from "./parse.js";

export type CbmProjectMapping = {
  version: 1;
  repo_id: string;
  root_path: string;
  cbm_project: string;
  mode: IndexMode;
  last_status: "ready" | "degraded";
  last_indexed_at: string;
  nodes: number;
  edges: number;
};

export type InitOpts = {
  mode?: IndexMode;
  waitTimeoutSec?: number;
  fetchCbm?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdinIsTTY?: boolean;
  httpsGet?: FetchCbmOpts["httpsGet"];
  asset?: FetchCbmOpts["asset"];
};

export type InitResult = {
  graph: "ready" | "degraded";
  repo_id: string;
  cbm_project: string;
  nodes: number;
  edges: number;
  playbook: string;
  mapping: CbmProjectMapping;
};

const LIST_LIMIT = 100;
const LIST_TIMEOUT_MS = 60_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCbmMapping(file: string): CbmProjectMapping | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (
      !isPlainObject(raw) ||
      raw.version !== 1 ||
      typeof raw.repo_id !== "string" ||
      typeof raw.root_path !== "string" ||
      typeof raw.cbm_project !== "string" ||
      (raw.last_status !== "ready" && raw.last_status !== "degraded")
    ) {
      return undefined;
    }
    return {
      version: 1,
      repo_id: raw.repo_id,
      root_path: raw.root_path,
      cbm_project: raw.cbm_project,
      mode: raw.mode === "fast" || raw.mode === "full" ? raw.mode : "moderate",
      last_status: raw.last_status,
      last_indexed_at: typeof raw.last_indexed_at === "string" ? raw.last_indexed_at : "",
      nodes: typeof raw.nodes === "number" ? raw.nodes : 0,
      edges: typeof raw.edges === "number" ? raw.edges : 0,
    };
  } catch {
    return undefined;
  }
}

function writeMapping(file: string, mapping: CbmProjectMapping): void {
  writeFileAtomicSync(file, `${JSON.stringify(mapping, null, 2)}\n`);
}

function realOrRaw(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function pickProject(projects: CbmProjectRow[], repoPath: string): CbmProjectRow | undefined {
  const matches = projects.filter((p) => realOrRaw(p.root_path) === repoPath);
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((a, b) => (b.indexed_at ?? "").localeCompare(a.indexed_at ?? ""));
  return matches[0];
}

async function listAllProjects(ctx: PlatformContext, binary: string): Promise<CbmProjectRow[]> {
  const projects: CbmProjectRow[] = [];
  let offset = 0;
  for (;;) {
    const body = await cbmCli(
      ctx,
      "list_projects",
      {
        "include-details": true,
        limit: LIST_LIMIT,
        offset,
      },
      { timeoutMs: LIST_TIMEOUT_MS, binary },
    );
    const page = parseProjectPage(body);
    projects.push(...page.projects);
    if (!page.has_more) {
      break;
    }
    offset += LIST_LIMIT;
    if (offset > 10_000) {
      break;
    }
  }
  return projects;
}

function readyStatus(status: string | undefined, nodes: number): "ready" | "degraded" | undefined {
  if (status === "indexed" || (!status && nodes > 0)) {
    return "ready";
  }
  if (status === "degraded") {
    return "degraded";
  }
  return undefined;
}

async function ensureBinary(ctx: PlatformContext, opts: InitOpts): Promise<string> {
  const found = await discoverCbmBinary(ctx);
  if (found) {
    return found;
  }
  const stdinIsTTY = opts.stdinIsTTY === true;
  if (!stdinIsTTY) {
    throw missingCbmInitError();
  }
  const stdin = opts.stdin;
  const stdout = opts.stdout;
  if (!stdin || !stdout) {
    throw missingCbmInitError();
  }
  const fetchOpts: FetchCbmOpts = {
    stdin,
    stdout,
    stdinIsTTY,
    ...(opts.httpsGet ? { httpsGet: opts.httpsGet } : {}),
    ...(opts.asset ? { asset: opts.asset } : {}),
  };
  let asset = opts.asset;
  if (!asset) {
    try {
      asset = selectCbmAsset();
    } catch (err) {
      throw graphUnavailable(err instanceof Error ? err.message : "No pinned CBM build");
    }
  }
  const dest = join(ctx.paths.binDir, cbmBinaryName());
  const yes = await confirmPinnedFetch(fetchOpts, asset, dest);
  if (!yes) {
    throw missingCbmInitError();
  }
  return fetchPinnedCbm(ctx, fetchOpts);
}

export async function initGraph(ctx: PlatformContext, opts: InitOpts = {}): Promise<InitResult> {
  const mode: IndexMode = opts.mode ?? ctx.config.platform.graph.index_mode;
  const timeoutSec = opts.waitTimeoutSec ?? ctx.config.platform.graph.wait_timeout_sec;
  const timeoutMs = Math.max(1, timeoutSec) * 1000;
  const binary = await ensureBinary(ctx, opts);

  const listed = await listAllProjects(ctx, binary);
  const matched = pickProject(listed, ctx.repoPath);

  const indexBody = parseIndexBody(
    await cbmCli(
      ctx,
      "index_repository",
      {
        "repo-path": ctx.repoPath,
        mode,
      },
      { timeoutMs, binary },
    ),
  );

  let status = indexBody.status;
  let name = indexBody.name ?? matched?.name ?? basename(ctx.repoPath);
  let nodes = indexBody.nodes;
  let edges = indexBody.edges;

  if (!status || status === "running") {
    const st = parseIndexBody(
      await cbmCli(ctx, "index_status", { project: name }, { timeoutMs: LIST_TIMEOUT_MS, binary }),
    );
    status = st.status ?? status;
    name = st.name ?? name;
    nodes = st.nodes || nodes;
    edges = st.edges || edges;
  }

  const graph = readyStatus(status, nodes);
  if (!graph) {
    throw graphUnavailable(`Graph index failed (status ${status ?? "unknown"})`);
  }

  const mapping: CbmProjectMapping = {
    version: 1,
    repo_id: ctx.repoId,
    root_path: ctx.repoPath,
    cbm_project: name,
    mode,
    last_status: graph,
    last_indexed_at: new Date().toISOString(),
    nodes,
    edges,
  };
  writeMapping(ctx.paths.cbmProjectFile, mapping);
  return {
    graph,
    repo_id: ctx.repoId,
    cbm_project: name,
    nodes,
    edges,
    playbook: ctx.paths.playbookFile,
    mapping,
  };
}

export function formatInitStdout(ctx: PlatformContext, result: InitResult): string {
  const lines = [
    `graph: ${result.graph}`,
    `repo_id: ${result.repo_id}`,
    `cbm_project: ${result.cbm_project}`,
    `nodes: ${result.nodes}`,
    `edges: ${result.edges}`,
    `playbook: ${result.playbook}`,
  ];
  if (ctx.identity.kind === "path") {
    lines.push("note: no git remote; playbook stays on this path");
  }
  return `${lines.join("\n")}\n`;
}
