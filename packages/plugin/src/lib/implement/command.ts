import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceResult, PlatformContext } from "@coredevkit/platform";
import {
  currentStackItem,
  resumeAfterMark,
  resumeStep,
} from "../coordinator/resume.js";
import { withProgressLock } from "../coordinator/store.js";
import {
  STEP_STATUSES,
  TERMINAL,
  type CoordinatorRecord,
  type CoordinatorStep,
  type EvidenceSnap,
  type ProgressEvent,
  type StepStatus,
} from "../coordinator/types.js";
import { PluginError } from "../errors.js";
import {
  acceptAdversarialPatch,
  markAdversarialSkipped,
  newAdversarialSessionId,
  printAdversarialFindings,
  runAdversarialCheckpoint,
  shouldRunAdversarial,
} from "../gates/adversarial.js";
import { evidenceBeforeDone, evidenceGateExit } from "../gates/evidence.js";
import { logPlugin } from "../log.js";
import { graphStateFromMapping } from "../plan/graph-state.js";
import { htmlHint, type RunPacket } from "../plan/packet.js";
import type { PlatformModule } from "../platform-guard.js";
import { loadPluginConfig, type PluginConfig } from "../plugin-config.js";
import { buildPacket } from "../subagents/packet.js";
import { resolveSubagent } from "../subagents/resolve.js";
import { worktreeHash } from "../worktree.js";

export type ImplementCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type ImplementArgv = {
  remaining: string[];
  plan?: string;
  step?: string;
  mark?: string;
  evidenceCommand?: string;
  evidencePurpose?: string;
  forceEvidence: boolean;
  acceptPatch: boolean;
};

function overrideLoaded(ctx: PlatformContext, skill: string): boolean {
  return existsSync(join(ctx.paths.overridesDir, `${skill}.override.md`));
}

function writePacket(io: ImplementCliIo, packet: RunPacket): void {
  io.stdout.write(`${JSON.stringify(packet)}\n`);
  io.stderr.write(`${packet.hint}\n`);
}

function snapFrom(result: EvidenceResult, at: string): EvidenceSnap {
  return {
    ok: result.ok,
    verdict: result.verdict,
    command: result.command,
    attempts: result.attempts,
    recorded: result.recorded,
    at,
  };
}

function skippedSnap(at: string): EvidenceSnap {
  return {
    ok: true,
    verdict: "skipped",
    command: null,
    attempts: 0,
    recorded: "skipped",
    at,
  };
}

function applyStatus(
  record: CoordinatorRecord,
  step: CoordinatorStep,
  status: StepStatus,
  extra: {
    evidence?: EvidenceSnap | null;
    blocked_reason?: string | null;
  } = {},
): void {
  step.status = status;
  if (extra.evidence !== undefined) {
    step.evidence = extra.evidence;
  }
  if (status === "blocked") {
    step.blocked_reason = extra.blocked_reason ?? step.blocked_reason;
  } else if (
    status === "done" ||
    status === "done_by_user" ||
    status === "skipped"
  ) {
    step.blocked_reason = extra.blocked_reason ?? null;
  }
  const at = extra.evidence?.at ?? new Date().toISOString();
  const ev: ProgressEvent = { step_title: step.step_title, status, at };
  if (step.command_key) {
    ev.command_key = step.command_key;
  }
  record.events.push(ev);
  record.updated_at = at;
  record.resume_step_id = resumeAfterMark(record, step.id, status);
}

function implementHint(record: CoordinatorRecord): string {
  if (record.stack.enabled) {
    const item = currentStackItem(record);
    if (item?.phase === "checked_out") {
      const left = record.steps.some(
        (s) => s.stack_id === item.stack_id && !TERMINAL.has(s.status),
      );
      if (!left) {
        return "run devkit stack publish";
      }
    }
  }
  return htmlHint(record.html_path);
}

function stackPhase(record: CoordinatorRecord): {
  stack_phase: RunPacket["stack_phase"];
  stack_branch: string | null;
} {
  if (!record.stack.enabled) {
    return { stack_phase: null, stack_branch: null };
  }
  const item = currentStackItem(record);
  return {
    stack_phase: item?.phase ?? null,
    stack_branch: item?.branch ?? null,
  };
}

function findStep(record: CoordinatorRecord, id: string): CoordinatorStep {
  const step = record.steps.find((s) => s.id === id);
  if (!step) {
    throw new PluginError("not_found", `Step not found: ${id}`);
  }
  return step;
}

function assertStackPause(
  record: CoordinatorRecord,
  stepId: string | null,
): void {
  if (!record.stack.enabled) {
    return;
  }
  if (record.stack.prs.length === 0) {
    throw new PluginError("usage", "stack.enabled but stack.prs is empty");
  }
  const item = currentStackItem(record);
  if (!item) {
    return;
  }
  if (item.phase !== "checked_out") {
    throw new PluginError("usage", "run devkit stack publish");
  }
  if (!stepId) {
    return;
  }
  const step = record.steps.find((s) => s.id === stepId);
  if (!step || step.stack_id !== item.stack_id) {
    throw new PluginError("usage", "step is not on the checked_out stack item");
  }
}

async function runAdversarialPrefix(
  ctx: PlatformContext,
  record: CoordinatorRecord,
  cfg: PluginConfig,
  platform: PlatformModule,
  acceptPatch: boolean,
  sessionId: string,
  write: (record: CoordinatorRecord) => Promise<void>,
  io: ImplementCliIo,
): Promise<void> {
  if (acceptPatch) {
    acceptAdversarialPatch(record);
    await write(record);
    return;
  }
  if (
    record.adversarial.verdict === "PATCH" &&
    record.adversarial.status !== "passed"
  ) {
    printAdversarialFindings(io.stderr, record.adversarial.findings);
    throw new PluginError("blocked", "run devkit implement --accept-patch");
  }
  const run = shouldRunAdversarial({
    resolved_level: ctx.config.resolved_level,
    status: record.adversarial.status,
    verdict: record.adversarial.verdict,
    stepCount: record.steps.length,
    stackEnabled: record.stack.enabled,
    source: record.source,
    minSteps: cfg.verification.min_steps_for_adversarial,
  });
  if (run) {
    const out = await runAdversarialCheckpoint({
      ctx,
      record,
      autoPatch: ctx.config.verification.auto_patch,
      sessionId,
      review: (c, q) => platform.adversarialReview(c, q),
      stderr: io.stderr,
    });
    await write(record);
    if (out.action === "block") {
      throw new PluginError("blocked", "adversarial BLOCK");
    }
    if (out.action === "wait_accept") {
      throw new PluginError("blocked", "run devkit implement --accept-patch");
    }
    return;
  }
  if (
    record.adversarial.status === "blocked" ||
    (record.adversarial.verdict === "BLOCK" &&
      record.adversarial.status !== "passed")
  ) {
    printAdversarialFindings(io.stderr, record.adversarial.findings);
    throw new PluginError("blocked", "adversarial BLOCK");
  }
  if (markAdversarialSkipped(record)) {
    await write(record);
    logPlugin(ctx.env, {
      event: "plugin.adversarial.skipped",
      repo_id: ctx.repoId,
    });
  }
}

async function runPacket(
  ctx: PlatformContext,
  record: CoordinatorRecord,
  cfg: ReturnType<typeof loadPluginConfig>,
  platform: PlatformModule,
  step: CoordinatorStep | null,
  io: ImplementCliIo,
  extra: Partial<RunPacket> = {},
): Promise<void> {
  const wt = worktreeHash(ctx.repoPath);
  const stack = stackPhase(record);
  let packet: RunPacket["packet"] = null;
  let dispatch: RunPacket["dispatch"] = null;
  if (step) {
    packet = await buildPacket(ctx, cfg, step, (c, q) =>
      platform.playbookLookup(c, q),
    );
    dispatch = { role: "coder", agent: resolveSubagent(cfg, "coder") };
  }
  writePacket(io, {
    command: "implement",
    repo_id: ctx.repoId,
    worktree_hash: wt.worktree_hash,
    resolved_level: ctx.config.resolved_level,
    graph: graphStateFromMapping(ctx),
    plan_dir: record.plan_dir,
    html_path: record.html_path,
    agent_plan: record.agent_plan,
    resume_step_id: record.resume_step_id,
    stack_phase: stack.stack_phase,
    stack_branch: stack.stack_branch,
    adversarial_status: record.adversarial.status,
    dispatch,
    packet,
    skill: "implement",
    override_loaded: overrideLoaded(ctx, "implement"),
    hint: implementHint(record),
    ...extra,
  });
}

export async function runImplementCommand(
  platform: PlatformModule,
  argv: ImplementArgv,
  env: NodeJS.ProcessEnv,
  io: ImplementCliIo,
): Promise<number> {
  const started = Date.now();
  if (
    argv.mark !== undefined &&
    !(STEP_STATUSES as readonly string[]).includes(argv.mark)
  ) {
    throw new PluginError("usage", `Invalid step status ${argv.mark}`);
  }
  const mark = argv.mark as StepStatus | undefined;
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

  return withProgressLock(
    ctx,
    { plugin: cfg, configFile: args.config },
    async (api) => {
      const got = api.tryRead();
      if (got.corrupt) {
        throw new PluginError("usage", "coordinator file is corrupt");
      }
      if (!got.record) {
        throw new PluginError(
          "not_found",
          "coordinator file not found",
          "run devkit plan --start-coordinator",
        );
      }
      const record = got.record;
      const ids = record.blocking_open_question_ids;
      if (ids.length > 0) {
        throw new PluginError(
          "blocked",
          `blocking open questions: ${ids.join(", ")}`,
        );
      }

      const targetId = argv.step ?? resumeStep(record);
      assertStackPause(record, targetId);
      const sessionId = newAdversarialSessionId();
      await runAdversarialPrefix(
        ctx,
        record,
        cfg,
        platform,
        argv.acceptPatch,
        sessionId,
        (next) => api.write(next),
        io,
      );

      if (!mark) {
        if (!targetId) {
          record.resume_step_id = null;
          await runPacket(ctx, record, cfg, platform, null, io, {
            dispatch: null,
            packet: null,
          });
          logPlugin(env, {
            event: "plugin.implement.resume",
            repo_id: ctx.repoId,
            duration_ms: Date.now() - started,
            result: "complete",
          });
          return 0;
        }
        const step = findStep(record, targetId);
        let dirty = false;
        if (step.status === "pending") {
          applyStatus(record, step, "in_progress");
          dirty = true;
        }
        if (record.resume_step_id !== step.id) {
          record.resume_step_id = step.id;
          dirty = true;
        }
        if (dirty) {
          await api.write(record);
        }
        await runPacket(ctx, record, cfg, platform, step, io);
        logPlugin(env, {
          event: "plugin.implement.resume",
          repo_id: ctx.repoId,
          duration_ms: Date.now() - started,
          result: "packet",
        });
        return 0;
      }

      if (!targetId) {
        throw new PluginError("usage", "no step to mark");
      }
      const step = findStep(record, targetId);

      if (mark !== "done") {
        applyStatus(record, step, mark);
        await api.write(record);
        await runPacket(ctx, record, cfg, platform, null, io, {
          dispatch: null,
          packet: null,
        });
        logPlugin(env, {
          event: "plugin.implement.resume",
          repo_id: ctx.repoId,
          duration_ms: Date.now() - started,
          result: "mark",
        });
        return 0;
      }

      const level = ctx.config.resolved_level;
      if (level === "off") {
        const at = new Date().toISOString();
        applyStatus(record, step, "done", { evidence: skippedSnap(at) });
        await api.write(record);
        await runPacket(ctx, record, cfg, platform, null, io, {
          dispatch: null,
          packet: null,
        });
        logPlugin(env, {
          event: "plugin.implement.resume",
          repo_id: ctx.repoId,
          duration_ms: Date.now() - started,
          result: "mark",
        });
        return 0;
      }

      const result = await evidenceBeforeDone({
        ctx,
        step,
        evidenceCommand: argv.evidenceCommand,
        evidencePurpose: argv.evidencePurpose,
        forceEvidence: argv.forceEvidence,
        evidenceCheck: (c, input) => platform.evidenceCheck(c, input),
        playbookList: (c, n) => platform.playbookList(c, n),
      });
      const gate = evidenceGateExit(result);
      const at = new Date().toISOString();
      const snap = snapFrom(result, at);
      if (gate !== 0) {
        applyStatus(record, step, "blocked", {
          evidence: snap,
          blocked_reason: `evidence ${result.verdict}`,
        });
        await api.write(record);
        logPlugin(env, {
          event: "plugin.gate.blocked",
          repo_id: ctx.repoId,
          code: "evidence",
          result: result.verdict,
        });
        throw new PluginError(
          gate === 3 ? "io" : "blocked",
          `evidence ${result.verdict}`,
        );
      }
      applyStatus(record, step, "done", { evidence: snap });
      await api.write(record);
      await runPacket(ctx, record, cfg, platform, null, io, {
        dispatch: null,
        packet: null,
      });
      logPlugin(env, {
        event: "plugin.implement.resume",
        repo_id: ctx.repoId,
        duration_ms: Date.now() - started,
        result: "mark",
      });
      return 0;
    },
  );
}
