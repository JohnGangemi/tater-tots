import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  GraphImpactOut,
  PlatformContext,
} from "@coredevkit/platform";
import { PluginError } from "../errors.js";
import {
  graphStateFromMapping,
  requireGraphMapping,
  type PacketGraph,
} from "../plan/graph-state.js";
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

export type ReviewCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type ReviewArgv = {
  remaining: string[];
  plan?: string;
  scope?: string;
};

const IMPACT_CAP = 20;

function overrideLoaded(ctx: PlatformContext, skill: string): boolean {
  return existsSync(join(ctx.paths.overridesDir, `${skill}.override.md`));
}

function writePacket(io: ReviewCliIo, packet: RunPacket): void {
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

function gitNameOnly(repoPath: string, args: string[]): string[] {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      shell: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function collectDiffPaths(repoPath: string, scope?: string): string[] {
  if (scope && scope.trim()) {
    return [scope.trim()].slice(0, IMPACT_CAP);
  }
  const names = [
    ...gitNameOnly(repoPath, ["diff", "--name-only"]),
    ...gitNameOnly(repoPath, ["diff", "--cached", "--name-only"]),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
    if (out.length >= IMPACT_CAP) {
      break;
    }
  }
  return out;
}

function hintsFromImpact(
  paths: string[],
  impacts: GraphImpactOut[],
): { query: string; path?: string }[] {
  const out: { query: string; path?: string }[] = [];
  const seen = new Set<string>();
  const push = (query: string, path?: string): void => {
    const key = `${query}\0${path ?? ""}`;
    if (!query || seen.has(key)) {
      return;
    }
    seen.add(key);
    const item: { query: string; path?: string } = { query };
    if (path) {
      item.path = path;
    }
    out.push(item);
  };
  for (const p of paths) {
    for (const h of graphHintsFromText(p)) {
      push(h.query, p);
      if (out.length >= 5) {
        return out;
      }
    }
  }
  for (const impact of impacts) {
    for (const hit of [...impact.callers, ...impact.dependents]) {
      push(hit.name || hit.path, hit.path || undefined);
      if (out.length >= 5) {
        return out;
      }
    }
  }
  return out;
}

export async function runReviewCommand(
  platform: PlatformModule,
  argv: ReviewArgv,
  env: NodeJS.ProcessEnv,
  io: ReviewCliIo,
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
  requireGraphMapping(ctx);
  const paths = collectDiffPaths(ctx.repoPath, argv.scope);
  const impacts: GraphImpactOut[] = [];
  let graph: PacketGraph = graphStateFromMapping(ctx);
  for (const path of paths) {
    const impact: GraphImpactOut = await platform
      .graphImpact(ctx, { path })
      .catch((err: unknown) => rethrowGraph(err, platform));
    impacts.push(impact);
    graph = impact.graph;
  }

  const reviewer = resolveSubagent(cfg, "reviewer");
  const wt = worktreeHash(ctx.repoPath);
  const planDir = resolvePlanDir(ctx, cfg, wt.worktree_hash);
  const planPaths = planFilePaths(planDir);
  const packet: SubagentPacket = {
    role: "reviewer",
    agent: reviewer,
    goal: argv.scope?.trim() || "review changed files",
    step_id: null,
    allowed_paths: paths.slice(),
    playbook_hints: [],
    graph_hints: hintsFromImpact(paths, impacts),
    constraints: [
      "Read-only. Do not implement.",
      "Do not walk the repository when graph tools respond.",
      "Do not mark coordinator done.",
    ],
  };
  writePacket(io, {
    command: "review",
    repo_id: ctx.repoId,
    worktree_hash: wt.worktree_hash,
    resolved_level: ctx.config.resolved_level,
    graph,
    plan_dir: planDir,
    html_path: planPaths.htmlPath,
    agent_plan: planPaths.agentPlan,
    resume_step_id: null,
    stack_phase: null,
    stack_branch: null,
    adversarial_status: null,
    dispatch: { role: "reviewer", agent: reviewer },
    packet,
    skill: "review",
    override_loaded: overrideLoaded(ctx, "review"),
    hint: "Dispatch reviewer. Do not mark coordinator done.",
  });
  return 0;
}
