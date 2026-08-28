import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceResult, PlatformContext } from "@coredevkit/platform";
import { resumeStep } from "../coordinator/resume.js";
import { withProgressLock } from "../coordinator/store.js";
import {
  TERMINAL,
  type CoordinatorRecord,
  type ProgressEvent,
} from "../coordinator/types.js";
import { PluginError } from "../errors.js";
import { evidenceGateExit } from "../gates/evidence.js";
import { logPlugin } from "../log.js";
import { graphStateFromMapping } from "../plan/graph-state.js";
import { htmlHint, type RunPacket } from "../plan/packet.js";
import { planFilePaths, resolvePlanDir } from "../plan/paths.js";
import type { PlatformModule } from "../platform-guard.js";
import { loadPluginConfig } from "../plugin-config.js";
import { worktreeHash } from "../worktree.js";

export type FinishCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type FinishArgv = {
  remaining: string[];
  plan?: string;
  skipRemaining: boolean;
};

export type FinishPacket = RunPacket & {
  remaining_step_ids: string[];
  stack_urls: string[];
};

function overrideLoaded(ctx: PlatformContext, skill: string): boolean {
  return existsSync(join(ctx.paths.overridesDir, `${skill}.override.md`));
}

function writePacket(io: FinishCliIo, packet: FinishPacket): void {
  io.stdout.write(`${JSON.stringify(packet)}\n`);
  io.stderr.write(`${packet.hint}\n`);
}

function remainingIds(record: CoordinatorRecord | null): string[] {
  if (!record) {
    return [];
  }
  return record.steps.filter((s) => !TERMINAL.has(s.status)).map((s) => s.id);
}

function stackUrls(record: CoordinatorRecord | null): string[] {
  if (!record) {
    return [];
  }
  const out: string[] = [];
  for (const pr of record.stack.prs) {
    if (pr.pr_url) {
      out.push(pr.pr_url);
    }
  }
  return out;
}

function skipPending(record: CoordinatorRecord): void {
  const at = new Date().toISOString();
  for (const step of record.steps) {
    if (step.status !== "pending") {
      continue;
    }
    step.status = "skipped";
    step.blocked_reason = null;
    const ev: ProgressEvent = {
      step_title: step.step_title,
      status: "skipped",
      at,
    };
    if (step.command_key) {
      ev.command_key = step.command_key;
    }
    record.events.push(ev);
  }
  record.updated_at = at;
  record.resume_step_id = resumeStep(record);
}

function adversarialStatus(
  record: CoordinatorRecord | null,
): RunPacket["adversarial_status"] {
  const status = record?.adversarial?.status;
  if (status === "skipped" || status === "passed" || status === "blocked") {
    return status;
  }
  return null;
}

function finishHint(
  htmlPath: string,
  remaining: string[],
  urls: string[],
  adversarial: RunPacket["adversarial_status"],
): string {
  const parts: string[] = [];
  if (remaining.length > 0) {
    parts.push(`Remaining ${remaining.join(" ")}.`);
  } else {
    parts.push("No remaining steps.");
  }
  parts.push(htmlHint(htmlPath));
  if (urls.length > 0) {
    parts.push(`Stack: ${urls.join(" ")}.`);
  }
  if (adversarial) {
    parts.push(`Adversarial: ${adversarial}.`);
  }
  return parts.join(" ");
}

async function runEvidence(
  platform: PlatformModule,
  ctx: PlatformContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const level = ctx.config.resolved_level;
  if (level !== "light" && level !== "full") {
    return;
  }
  const result: EvidenceResult = await platform.evidenceCheck(ctx, {
    purpose: "test",
  });
  const gate = evidenceGateExit(result);
  if (gate === 0) {
    return;
  }
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

export async function runFinishCommand(
  platform: PlatformModule,
  argv: FinishArgv,
  env: NodeJS.ProcessEnv,
  io: FinishCliIo,
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

  return withProgressLock(
    ctx,
    { plugin: cfg, configFile: args.config },
    async (api) => {
      const got = api.tryRead();
      if (got.corrupt) {
        throw new PluginError("usage", "coordinator file is corrupt");
      }
      const record = got.record;
      if (argv.skipRemaining && !record) {
        throw new PluginError(
          "not_found",
          "coordinator file not found",
          "run devkit plan --start-coordinator",
        );
      }

      await runEvidence(platform, ctx, env);

      if (argv.skipRemaining && record) {
        skipPending(record);
        await api.write(record);
      }

      const remaining = remainingIds(record);
      const urls = stackUrls(record);
      const adversarial = adversarialStatus(record);
      const htmlPath = record?.html_path ?? paths.htmlPath;
      writePacket(io, {
        command: "finish",
        repo_id: ctx.repoId,
        worktree_hash: wt.worktree_hash,
        resolved_level: ctx.config.resolved_level,
        graph: graphStateFromMapping(ctx),
        plan_dir: record?.plan_dir ?? planDir,
        html_path: htmlPath,
        agent_plan: record?.agent_plan ?? paths.agentPlan,
        resume_step_id: record?.resume_step_id ?? null,
        stack_phase: null,
        stack_branch: null,
        adversarial_status: adversarial,
        dispatch: null,
        packet: null,
        skill: "finish",
        override_loaded: overrideLoaded(ctx, "finish"),
        hint: finishHint(htmlPath, remaining, urls, adversarial),
        remaining_step_ids: remaining,
        stack_urls: urls,
      });
      return 0;
    },
  );
}
