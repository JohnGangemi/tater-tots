import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  GraphSearchOut,
  LookupOut,
  PlatformContext,
} from "@coredevkit/platform";
import { PluginError } from "../errors.js";
import { graphStateFromMapping, requireGraphMapping } from "../plan/graph-state.js";
import {
  graphHintsFromText,
  type RunPacket,
  type SubagentPacket,
} from "../plan/packet.js";
import { planFilePaths, resolvePlanDir } from "../plan/paths.js";
import type { PlatformModule } from "../platform-guard.js";
import { loadPluginConfig } from "../plugin-config.js";
import { resolveSubagent } from "../subagents/resolve.js";
import { worktreeHash } from "../worktree.js";

export type DebugCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type DebugArgv = {
  remaining: string[];
  plan?: string;
  query?: string;
};

function overrideLoaded(ctx: PlatformContext, skill: string): boolean {
  return existsSync(join(ctx.paths.overridesDir, `${skill}.override.md`));
}

function writePacket(io: DebugCliIo, packet: RunPacket): void {
  io.stdout.write(`${JSON.stringify(packet)}\n`);
  io.stderr.write(`${packet.hint}\n`);
}

function rethrowGraph(err: unknown, platform: PlatformModule): never {
  if (
    platform.isPlatformError(err) &&
    (err.code === "graph_unavailable" || err.code === "graph_timeout")
  ) {
    throw new PluginError("io", err.message, err.hint ?? "run devkit init");
  }
  throw err;
}

function hintsFromSearch(
  query: string,
  search: GraphSearchOut,
): { query: string; path?: string }[] {
  const out = graphHintsFromText(query);
  const seen = new Set(out.map((h) => h.query));
  for (const hit of search.hits) {
    const token = hit.name || query;
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    const item: { query: string; path?: string } = { query: token };
    if (hit.path) {
      item.path = hit.path;
    }
    out.push(item);
    if (out.length >= 5) {
      break;
    }
  }
  return out;
}

function allowedFromSearch(search: GraphSearchOut): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of search.hits) {
    if (!hit.path || seen.has(hit.path)) {
      continue;
    }
    seen.add(hit.path);
    out.push(hit.path);
  }
  return out;
}

function playbookHints(lookup: LookupOut): SubagentPacket["playbook_hints"] {
  return lookup.commands.slice(0, 5).map((hit) => ({
    purpose: hit.purpose_tags[0] ?? "test",
    command: hit.command,
  }));
}

export async function runDebugCommand(
  platform: PlatformModule,
  argv: DebugArgv,
  env: NodeJS.ProcessEnv,
  io: DebugCliIo,
): Promise<number> {
  const args = platform.parseArgv(argv.remaining);
  const ctx = await platform.createContext({
    repoPath: args.path,
    configFile: args.config,
    verification: args.verification,
    env,
  });
  const cfg = loadPluginConfig(ctx, {
    configFile: args.config,
    ...(argv.plan !== undefined ? { planDir: argv.plan } : {}),
  });
  const query = argv.query ?? "";
  requireGraphMapping(ctx);

  const search: GraphSearchOut = await platform
    .graphSearch(ctx, { query })
    .catch((err: unknown) => rethrowGraph(err, platform));
  const lookup: LookupOut = await platform
    .playbookLookup(ctx, { purpose: "test" })
    .catch((err: unknown) => rethrowGraph(err, platform));

  const explorer = resolveSubagent(cfg, "explorer");
  const coder = resolveSubagent(cfg, "coder");
  const wt = worktreeHash(ctx.repoPath);
  const planDir = resolvePlanDir(ctx, cfg, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  const packet: SubagentPacket = {
    role: "explorer",
    agent: explorer,
    goal: query,
    step_id: null,
    allowed_paths: allowedFromSearch(search),
    playbook_hints: playbookHints(lookup),
    graph_hints: hintsFromSearch(query, search),
    constraints: [
      "Dispatch explorer first.",
      `Then dispatch ${coder}.`,
      "Do not walk the repository when graph tools respond.",
      "Call evidence_check to reproduce the failure.",
      "Coordinator is optional.",
    ],
  };
  writePacket(io, {
    command: "debug",
    repo_id: ctx.repoId,
    worktree_hash: wt.worktree_hash,
    resolved_level: ctx.config.resolved_level,
    graph: search.graph ?? graphStateFromMapping(ctx),
    plan_dir: planDir,
    html_path: paths.htmlPath,
    agent_plan: paths.agentPlan,
    resume_step_id: null,
    stack_phase: null,
    stack_branch: null,
    adversarial_status: null,
    dispatch: { role: "explorer", agent: explorer },
    packet,
    skill: "debug",
    override_loaded: overrideLoaded(ctx, "debug"),
    hint: `Dispatch explorer then ${coder}. Do not walk the repository.`,
  });
  return 0;
}
