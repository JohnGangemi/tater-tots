import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "@coredevkit/platform";
import { withProgressLock } from "../coordinator/store.js";
import { currentStackItem } from "../coordinator/resume.js";
import type { CoordinatorRecord } from "../coordinator/types.js";
import { PluginError } from "../errors.js";
import { logPlugin } from "../log.js";
import { graphStateFromMapping, requireGraphMapping } from "../plan/graph-state.js";
import {
  loadIntentFile,
  needsPlanDesigner,
  type PlanIntent,
} from "../plan/intent.js";
import {
  graphHintsFromText,
  htmlHint,
  type RunPacket,
  type SubagentPacket,
} from "../plan/packet.js";
import { planFilePaths, resolvePlanDir } from "../plan/paths.js";
import { startCoordinator } from "../plan/start-coordinator.js";
import type { PlatformModule } from "../platform-guard.js";
import { loadPluginConfig, type PluginConfig } from "../plugin-config.js";
import { resolveSubagent } from "../subagents/resolve.js";
import { worktreeHash } from "../worktree.js";
import {
  issueSummary,
  viewIssue,
  type IssueSnap,
} from "./gh-issue.js";
import {
  allStepsTerminal,
  draftPhase,
  issueMetaFrom,
  publishIssue,
  sowFilePath,
  stackSkipFromCtx,
  writeSow,
  type IssueMeta,
} from "./pipeline.js";

export type IssueCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type IssueArgv = {
  remaining: string[];
  plan?: string;
  issue?: string;
  acceptPlan: boolean;
  publish: boolean;
};

export type IssueRunPacket = RunPacket & {
  pipeline_phase: CoordinatorRecord["pipeline_phase"];
  sow_path: string;
  issue: IssueMeta | null;
};

function overrideLoaded(ctx: PlatformContext, skill: string): boolean {
  return existsSync(join(ctx.paths.overridesDir, `${skill}.override.md`));
}

function writePacket(io: IssueCliIo, packet: IssueRunPacket): void {
  io.stdout.write(`${JSON.stringify(packet)}\n`);
  io.stderr.write(`${packet.hint}\n`);
}

function tryIntent(intentPath: string, cfg: PluginConfig): PlanIntent | null {
  if (!existsSync(intentPath)) {
    return null;
  }
  return loadIntentFile(intentPath, {
    htmlCodeBlocks: cfg.plugin.html_code_blocks,
  });
}

function writingPlansPacket(
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
    constraints: [
      "Do not write the raw issue body into the plan directory.",
      "Wait for --accept-plan. Do not auto-continue after one refine pass.",
    ],
  };
  return {
    dispatch: designer ? { role, agent } : null,
    packet,
  };
}

function basePacket(
  ctx: PlatformContext,
  planDir: string,
  sowPath: string,
  extra: Partial<IssueRunPacket>,
): IssueRunPacket {
  const paths = planFilePaths(planDir);
  const wt = worktreeHash(ctx.repoPath);
  return {
    command: "issue-to-pr",
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
    skill: "issue-to-pr",
    override_loaded: overrideLoaded(ctx, "issue-to-pr"),
    hint: htmlHint(paths.htmlPath),
    pipeline_phase: null,
    sow_path: sowPath,
    issue: null,
    ...extra,
  };
}

function acceptedSource(record: CoordinatorRecord | null): boolean {
  return record?.source === "issue-to-pr";
}

export async function runIssueToPrCommand(
  platform: PlatformModule,
  argv: IssueArgv,
  env: NodeJS.ProcessEnv,
  io: IssueCliIo,
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
  const wt = worktreeHash(ctx.repoPath);
  const planDir = resolvePlanDir(ctx, cfg, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  const sowPath = sowFilePath(ctx.paths.progressDir, wt.worktree_hash);
  const coordOpts = { plugin: cfg, configFile: args.config };

  const existing = await withProgressLock(ctx, coordOpts, async (api) => {
    const got = api.tryRead();
    if (got.corrupt) {
      throw new PluginError("usage", "coordinator file is corrupt");
    }
    return got.record;
  });

  let issue: IssueSnap | null = null;
  let meta: IssueMeta | null = existing?.issue ?? null;
  const git = { cwd: ctx.repoPath, env: ctx.env };

  if (argv.issue) {
    issue = viewIssue(argv.issue, git);
    meta = issueMetaFrom(issue);
    await writeSow(ctx.paths.progressDir, wt.worktree_hash, issue);
    logPlugin(env, {
      event: "plugin.issue_to_pr.start",
      repo_id: ctx.repoId,
      issue: issue.number,
    });
    io.stderr.write(`${issueSummary(issue)}\n`);
  } else if (!meta) {
    throw new PluginError("usage", "need --issue <n|url>");
  } else if (!existsSync(sowPath)) {
    throw new PluginError("usage", "need --issue <n|url>");
  }

  const alreadyAccepted = acceptedSource(existing);
  if (!argv.acceptPlan && !alreadyAccepted) {
    const phase = draftPhase(paths.agentPlan);
    requireGraphMapping(ctx);
    if (existing) {
      await withProgressLock(ctx, coordOpts, async (api) => {
        const got = api.tryRead();
        if (got.corrupt) {
          throw new PluginError("usage", "coordinator file is corrupt");
        }
        if (!got.record) {
          return;
        }
        got.record.pipeline_phase = phase;
        if (meta) {
          got.record.issue = meta;
        }
        got.record.updated_at = new Date().toISOString();
        await api.write(got.record);
      });
    }
    const intent = tryIntent(paths.intentPath, cfg);
    const { dispatch, packet } = writingPlansPacket(
      cfg,
      intent,
      meta?.title ?? "",
    );
    writePacket(
      io,
      basePacket(ctx, planDir, sowPath, {
        skill: "writing-plans",
        override_loaded: overrideLoaded(ctx, "writing-plans"),
        dispatch,
        packet,
        pipeline_phase: phase,
        issue: meta,
        hint: "wait for --accept-plan",
        adversarial_status: existing?.adversarial.status ?? null,
        resume_step_id: existing?.resume_step_id ?? null,
      }),
    );
    return 0;
  }

  let rec: CoordinatorRecord;
  if (!alreadyAccepted) {
    rec = await startCoordinator(ctx, {
      planDir,
      replace: false,
      slug: meta ? `issue-${meta.number}` : undefined,
      plugin: cfg,
      configFile: args.config,
      source: "issue-to-pr",
      issue: meta,
      pipeline_phase: "implement",
    });
  } else if (existing) {
    rec = existing;
  } else {
    throw new PluginError(
      "not_found",
      "coordinator file not found",
      "run devkit issue-to-pr --accept-plan",
    );
  }

  if (argv.publish) {
    return withProgressLock(ctx, coordOpts, async (api) => {
      const got = api.tryRead();
      if (got.corrupt) {
        throw new PluginError("usage", "coordinator file is corrupt");
      }
      if (!got.record) {
        throw new PluginError(
          "not_found",
          "coordinator file not found",
          "run devkit issue-to-pr --accept-plan",
        );
      }
      const out = await publishIssue({
        ctx,
        platform,
        record: got.record,
        write: (next) => api.write(next),
        io,
      });
      const skip = stackSkipFromCtx(ctx);
      const item = out.item ?? currentStackItem(out.record, skip) ?? null;
      writePacket(
        io,
        basePacket(ctx, planDir, sowPath, {
          plan_dir: out.record.plan_dir,
          html_path: out.record.html_path,
          agent_plan: out.record.agent_plan,
          resume_step_id: out.record.resume_step_id,
          stack_phase: item?.phase ?? null,
          stack_branch: item?.branch ?? null,
          adversarial_status: out.record.adversarial.status,
          pipeline_phase: out.record.pipeline_phase,
          issue: out.record.issue,
          hint: out.hint || htmlHint(out.record.html_path),
          skill: out.record.stack.enabled ? "implement" : "issue-to-pr",
        }),
      );
      return 0;
    });
  }

  const skip = stackSkipFromCtx(ctx);
  const item = currentStackItem(rec, skip);
  let hint = htmlHint(rec.html_path);
  let skill = "implement";
  let dispatch: RunPacket["dispatch"] = null;
  let packet: SubagentPacket | null = null;
  if (rec.stack.enabled) {
    if (!item || item.phase !== "checked_out") {
      hint = "run devkit issue-to-pr --publish";
      skill = "issue-to-pr";
    } else {
      hint = "run devkit implement";
      const agent = resolveSubagent(cfg, "coder");
      dispatch = { role: "coder", agent };
    }
  } else if (!allStepsTerminal(rec)) {
    hint = "run devkit implement";
    const agent = resolveSubagent(cfg, "coder");
    dispatch = { role: "coder", agent };
  } else {
    hint = "run devkit review then devkit issue-to-pr --publish";
    skill = "review";
    const agent = resolveSubagent(cfg, "reviewer");
    dispatch = { role: "reviewer", agent };
  }

  writePacket(
    io,
    basePacket(ctx, planDir, sowPath, {
      plan_dir: rec.plan_dir,
      html_path: rec.html_path,
      agent_plan: rec.agent_plan,
      resume_step_id: rec.resume_step_id,
      stack_phase: item?.phase ?? null,
      stack_branch: item?.branch ?? null,
      adversarial_status: rec.adversarial.status,
      dispatch,
      packet,
      skill,
      override_loaded: overrideLoaded(ctx, skill),
      pipeline_phase: rec.pipeline_phase,
      issue: rec.issue,
      hint,
    }),
  );
  return 0;
}
