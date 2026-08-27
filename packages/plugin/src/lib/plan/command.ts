import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "@coredevkit/platform";
import { logPlugin } from "../log.js";
import { loadPluginConfig, type PluginConfig } from "../plugin-config.js";
import { worktreeHash } from "../worktree.js";
import type { PlatformModule } from "../platform-guard.js";
import {
  loadIntentFile,
  needsPlanDesigner,
  type PlanIntent,
} from "./intent.js";
import { planFilePaths, resolvePlanDir } from "./paths.js";
import { renderPlanHtmlFile } from "./render-html.js";
import { graphStateFromMapping, requireGraphMapping } from "./graph-state.js";
import {
  graphHintsFromText,
  htmlHint,
  type RunPacket,
  type SubagentPacket,
} from "./packet.js";
import { startCoordinator } from "./start-coordinator.js";

export type PlanCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type PlanArgv = {
  remaining: string[];
  plan?: string;
  goal?: string;
  slug?: string;
  render: boolean;
  startCoordinator: boolean;
  replace: boolean;
};

function writePacket(io: PlanCliIo, packet: RunPacket): void {
  io.stdout.write(`${JSON.stringify(packet)}\n`);
  io.stderr.write(`${packet.hint}\n`);
}

function overrideLoaded(ctx: PlatformContext, skill: string): boolean {
  return existsSync(join(ctx.paths.overridesDir, `${skill}.override.md`));
}

function tryIntent(intentPath: string, cfg: PluginConfig): PlanIntent | null {
  if (!existsSync(intentPath)) {
    return null;
  }
  return loadIntentFile(intentPath, {
    htmlCodeBlocks: cfg.plugin.html_code_blocks,
  });
}

function buildDispatch(
  cfg: PluginConfig,
  intent: PlanIntent | null,
  goal: string,
): { dispatch: RunPacket["dispatch"]; packet: SubagentPacket } {
  const designer = Boolean(intent && needsPlanDesigner(intent));
  const role = designer ? "plan-designer" : "explorer";
  const agent = cfg.subagents[role];
  const packet: SubagentPacket = {
    role,
    agent,
    goal: goal || intent?.goal || "",
    step_id: null,
    allowed_paths: intent ? intent.components.map((c) => c.path) : [],
    playbook_hints: [],
    graph_hints: graphHintsFromText(goal || intent?.goal || ""),
    constraints: intent?.constraints ?? [],
  };
  return {
    dispatch: designer ? { role, agent } : null,
    packet,
  };
}

function basePacket(
  ctx: PlatformContext,
  planDir: string,
  extra: Partial<RunPacket>,
): RunPacket {
  const paths = planFilePaths(planDir);
  const wt = worktreeHash(ctx.repoPath);
  return {
    command: "plan",
    repo_id: ctx.repoId,
    worktree_hash: wt.worktree_hash,
    resolved_level: ctx.config.resolved_level,
    graph: graphStateFromMapping(ctx),
    plan_dir: planDir,
    html_path: paths.htmlPath,
    agent_plan: paths.agentPlan,
    resume_step_id: null,
    stack_phase: null,
    stack_branch: null,
    adversarial_status: null,
    dispatch: null,
    packet: null,
    skill: "writing-plans",
    override_loaded: overrideLoaded(ctx, "writing-plans"),
    hint: htmlHint(paths.htmlPath),
    ...extra,
  };
}

export async function runPlanCommand(
  platform: PlatformModule,
  argv: PlanArgv,
  env: NodeJS.ProcessEnv,
  io: PlanCliIo,
): Promise<number> {
  const started = Date.now();
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
  const wt = worktreeHash(ctx.repoPath);
  const planDir = resolvePlanDir(ctx, cfg, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  logPlugin(env, {
    event: "plugin.plan.start",
    repo_id: ctx.repoId,
  });

  const action = argv.render || argv.startCoordinator;
  if (!action) {
    const graph = requireGraphMapping(ctx);
    const intent = tryIntent(paths.intentPath, cfg);
    const { dispatch, packet } = buildDispatch(cfg, intent, argv.goal ?? "");
    writePacket(io, basePacket(ctx, planDir, { graph, dispatch, packet }));
    logPlugin(env, {
      event: "plugin.plan.complete",
      repo_id: ctx.repoId,
      duration_ms: Date.now() - started,
      result: "packet",
    });
    return 0;
  }

  if (argv.render) {
    await renderPlanHtmlFile(paths.intentPath, paths.htmlPath, {
      codeBlocks: cfg.plugin.html_code_blocks,
    });
  }

  let resume: string | null = null;
  let adversarial: RunPacket["adversarial_status"] = null;
  let stack_phase: RunPacket["stack_phase"] = null;
  let stack_branch: string | null = null;
  if (argv.startCoordinator) {
    const rec = await startCoordinator(ctx, {
      planDir,
      replace: argv.replace,
      slug: argv.slug,
      plugin: cfg,
      configFile: args.config,
    });
    resume = rec.resume_step_id;
    adversarial = rec.adversarial.status;
    const item = rec.stack.prs.find((p) => p.phase !== "pr_created");
    stack_phase = item?.phase ?? null;
    stack_branch = item?.branch ?? null;
  }

  const intent = tryIntent(paths.intentPath, cfg);
  const { dispatch, packet } = buildDispatch(cfg, intent, argv.goal ?? "");
  writePacket(
    io,
    basePacket(ctx, planDir, {
      resume_step_id: resume,
      adversarial_status: adversarial,
      stack_phase,
      stack_branch,
      dispatch,
      packet,
    }),
  );
  logPlugin(env, {
    event: "plugin.plan.complete",
    repo_id: ctx.repoId,
    duration_ms: Date.now() - started,
    result:
      argv.render && argv.startCoordinator
        ? "render+start"
        : argv.render
          ? "render"
          : "start",
  });
  return 0;
}
