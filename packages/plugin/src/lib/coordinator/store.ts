import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  applyUserOnlyDirSync,
  applyUserOnlyFileSync,
  ingestProgress,
  mkdirUserOnly,
  type PlatformContext,
} from "@coredevkit/platform";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { PluginError } from "../errors.js";
import { writeProgressAtomic } from "../fs-user.js";
import { logPlugin } from "../log.js";
import { loadPluginConfig, type PluginConfig } from "../plugin-config.js";
import { worktreeHash } from "../worktree.js";
import { resumeAfterMark, resumeStep } from "./resume.js";
import {
  STEP_STATUSES,
  type CoordinatorRecord,
  type CoordinatorStep,
  type ProgressEvent,
  type StepStatus,
} from "./types.js";

const MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 10_000;
const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 20;

const stepStatusZ = z.enum(STEP_STATUSES);
const adversarialStatusZ = z.enum(["skipped", "passed", "blocked"]);
const stackPhaseZ = z.enum([
  "none",
  "fetched",
  "checked_out",
  "committed",
  "pushed",
  "pr_created",
]);

const eventZ = z.object({
  step_title: z.string().min(1),
  status: stepStatusZ,
  command_key: z.string().min(1).optional(),
  at: z.string().min(1),
});

const stepZ = z.object({
  id: z.string().min(1),
  step_title: z.string().min(1),
  title: z.string().min(1),
  status: stepStatusZ,
  command_key: z.string().min(1).optional(),
  allowed_paths: z.array(z.string()),
  evidence: z
    .object({
      ok: z.boolean(),
      verdict: z.enum([
        "pass",
        "fail",
        "no_command",
        "denied",
        "error",
        "skipped",
      ]),
      command: z.string().nullable(),
      attempts: z.number(),
      recorded: z.enum(["stored", "excluded", "redacted", "skipped"]),
      at: z.string().min(1),
    })
    .nullable(),
  summaries: z.array(
    z.object({
      role: z.string(),
      agent: z.string(),
      text: z.string(),
      at: z.string().min(1),
    }),
  ),
  blocked_reason: z.string().nullable(),
  stack_id: z.string().nullable(),
});

const prZ = z.object({
  stack_id: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  pr_number: z.number().nullable(),
  pr_url: z.string().nullable(),
  pr_state: z.enum(["none", "created", "merged", "closed"]),
  phase: stackPhaseZ,
  commit_sha: z.string().nullable(),
  allowed_paths: z.array(z.string()),
});

const recordZ = z.object({
  version: z.literal(1),
  repo_id: z.string().min(1),
  worktree_hash: z.string().min(1),
  worktree_sha256: z.string().min(1),
  plan_id: z.string().min(1),
  plan_dir: z.string().min(1),
  intent_path: z.string().min(1),
  agent_plan: z.string().min(1),
  html_path: z.string().min(1),
  source: z.enum(["plan", "issue-to-pr"]),
  issue: z
    .object({
      number: z.number(),
      url: z.string(),
      title: z.string(),
    })
    .nullable(),
  pipeline_phase: z
    .enum([
      "read_issue",
      "sow",
      "draft_plan",
      "refine",
      "implement",
      "branch_review",
      "security_review",
      "tests",
      "publish",
      "complete",
    ])
    .nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  verification_level: z.enum(["off", "light", "full"]),
  adversarial: z.object({
    status: adversarialStatusZ,
    verdict: z.enum(["BLOCK", "PATCH", "PASS"]).nullable(),
    ran_at: z.string().nullable(),
    session_id: z.string().nullable(),
    findings_hash: z.string().nullable(),
  }),
  resume_step_id: z.string().nullable(),
  blocking_open_question_ids: z.array(z.string()),
  stack: z.object({
    enabled: z.boolean(),
    default_branch: z.string().nullable(),
    prs: z.array(prZ),
  }),
  events: z.array(eventZ),
  steps: z.array(stepZ),
});

function isWindows(): boolean {
  return process.platform === "win32";
}

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code?: string }).code ?? "");
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function projectProgressIgnored(repoPath: string): boolean {
  const r = spawnSync(
    "git",
    ["check-ignore", "-q", "--no-index", ".devkit/progress.yaml"],
    {
      cwd: repoPath,
      encoding: "utf8",
      shell: false,
      stdio: "ignore",
      timeout: 10_000,
    },
  );
  return r.status === 0;
}

export function progressFilePath(
  ctx: PlatformContext,
  pluginCfg?: PluginConfig,
): string {
  const cfg = pluginCfg ?? loadPluginConfig(ctx);
  const { worktree_hash } = worktreeHash(ctx.repoPath);
  if (cfg.plugin.progress_location === "project") {
    if (!projectProgressIgnored(ctx.repoPath)) {
      throw new PluginError(
        "usage",
        "refusing .devkit/progress.yaml because .devkit/ is not gitignored",
      );
    }
    return join(ctx.repoPath, ".devkit", "progress.yaml");
  }
  return join(ctx.paths.progressDir, `${worktree_hash}.yaml`);
}

function lockPathFor(ctx: PlatformContext, dest: string): string {
  const { worktree_hash } = worktreeHash(ctx.repoPath);
  return join(dirname(dest), ".locks", `${worktree_hash}.lock`);
}

function lockPayloadFile(lockPath: string): string {
  return isWindows() ? lockPath : join(lockPath, "lock.json");
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPayloadFile(lockPath), "utf8")) as {
      pid?: unknown;
    };
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid)) {
      return undefined;
    }
    return raw.pid;
  } catch {
    return undefined;
  }
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return errCode(err) === "ESRCH";
  }
}

function canSteal(lockPath: string): boolean {
  const pid = readLockPid(lockPath);
  if (pid === undefined) {
    return true;
  }
  return pidIsDead(pid);
}

function removeLock(lockPath: string): void {
  try {
    if (isWindows()) {
      unlinkSync(lockPath);
    } else {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch {
    // retry loop handles leftovers
  }
}

function writeLockPayload(lockPath: string): void {
  const body = `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`;
  if (isWindows()) {
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      writeSync(fd, Buffer.from(body, "utf8"));
    } finally {
      closeSync(fd);
    }
    applyUserOnlyFileSync(lockPath);
    return;
  }
  mkdirSync(lockPath);
  applyUserOnlyDirSync(lockPath);
  const payload = join(lockPath, "lock.json");
  writeFileSync(payload, body, { encoding: "utf8", mode: 0o600 });
  applyUserOnlyFileSync(payload);
}

async function acquireProgressLock(
  ctx: PlatformContext,
  dest: string,
): Promise<() => void> {
  const lockPath = lockPathFor(ctx, dest);
  await mkdirUserOnly(dirname(lockPath));
  for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
    try {
      writeLockPayload(lockPath);
      return () => {
        removeLock(lockPath);
      };
    } catch (err) {
      if (errCode(err) !== "EEXIST") {
        throw new PluginError(
          "io",
          `Could not create lock ${lockPath}`,
          String(err),
        );
      }
      if (canSteal(lockPath)) {
        removeLock(lockPath);
        continue;
      }
      if (attempt === LOCK_TRIES - 1) {
        throw new PluginError("io", `Could not acquire lock ${lockPath}`);
      }
      await sleep(LOCK_WAIT_MS);
    }
  }
  throw new PluginError("io", `Could not acquire lock ${lockPath}`);
}

function corrupt(): never {
  throw new PluginError("usage", "coordinator file is corrupt");
}

function asRecord(value: unknown): CoordinatorRecord {
  const parsed = recordZ.safeParse(value);
  if (!parsed.success) {
    corrupt();
  }
  return parsed.data as CoordinatorRecord;
}

export function parseCoordinator(text: string): CoordinatorRecord {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    corrupt();
  }
  return asRecord(raw);
}

function eventToYaml(ev: ProgressEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    step_title: ev.step_title,
    status: ev.status,
    at: ev.at,
  };
  if (ev.command_key) {
    out.command_key = ev.command_key;
  }
  return out;
}

function stepToYaml(step: CoordinatorStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: step.id,
    step_title: step.step_title,
    title: step.title,
    status: step.status,
    allowed_paths: step.allowed_paths,
    evidence: step.evidence,
    summaries: step.summaries,
    blocked_reason: step.blocked_reason,
    stack_id: step.stack_id,
  };
  if (step.command_key) {
    out.command_key = step.command_key;
  }
  return out;
}

export function stringifyCoordinator(record: CoordinatorRecord): string {
  const ordered: Record<string, unknown> = {
    version: record.version,
    repo_id: record.repo_id,
    worktree_hash: record.worktree_hash,
    worktree_sha256: record.worktree_sha256,
    plan_id: record.plan_id,
    plan_dir: record.plan_dir,
    intent_path: record.intent_path,
    agent_plan: record.agent_plan,
    html_path: record.html_path,
    source: record.source,
    issue: record.issue,
    pipeline_phase: record.pipeline_phase,
    created_at: record.created_at,
    updated_at: record.updated_at,
    verification_level: record.verification_level,
    adversarial: record.adversarial,
    resume_step_id: record.resume_step_id,
    blocking_open_question_ids: record.blocking_open_question_ids,
    stack: {
      enabled: record.stack.enabled,
      default_branch: record.stack.default_branch,
      prs: record.stack.prs.map((pr) => ({
        stack_id: pr.stack_id,
        branch: pr.branch,
        base: pr.base,
        pr_number: pr.pr_number,
        pr_url: pr.pr_url,
        pr_state: pr.pr_state,
        phase: pr.phase,
        commit_sha: pr.commit_sha,
        allowed_paths: pr.allowed_paths,
      })),
    },
    events: record.events.map(eventToYaml),
    steps: record.steps.map(stepToYaml),
  };
  const text = stringifyYaml(ordered);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function shouldIngest(record: CoordinatorRecord): boolean {
  const blocked = new Set<string>();
  for (const ev of record.events) {
    if (ev.status === "blocked") {
      blocked.add(ev.step_title);
    }
  }
  if (blocked.size === 0) {
    return false;
  }
  for (const ev of record.events) {
    if (
      (ev.status === "done" || ev.status === "done_by_user") &&
      blocked.has(ev.step_title)
    ) {
      return true;
    }
  }
  return false;
}

export async function loadCoordinator(
  ctx: PlatformContext,
): Promise<CoordinatorRecord> {
  const cfg = loadPluginConfig(ctx);
  const dest = progressFilePath(ctx, cfg);
  const release = await acquireProgressLock(ctx, dest);
  try {
    if (!existsSync(dest)) {
      throw new PluginError("not_found", "coordinator file not found");
    }
    let text: string;
    try {
      text = readFileSync(dest, "utf8");
    } catch (err) {
      throw new PluginError(
        "io",
        "Could not read coordinator file",
        String(err),
      );
    }
    const record = parseCoordinator(text);
    record.resume_step_id = resumeStep(record);
    return record;
  } finally {
    release();
  }
}

export async function saveCoordinator(
  ctx: PlatformContext,
  record: CoordinatorRecord,
): Promise<void> {
  const cfg = loadPluginConfig(ctx);
  const dest = progressFilePath(ctx, cfg);
  const parsed = asRecord(record);
  if (parsed.events.length > MAX_EVENTS) {
    logPlugin(ctx.env, {
      event: "plugin.coordinator.write",
      code: "events_cap",
      repo_id: ctx.repoId,
    });
  }
  const text = stringifyCoordinator(parsed);
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    throw new PluginError("io", "coordinator file exceeds 1 MiB");
  }
  const release = await acquireProgressLock(ctx, dest);
  try {
    await writeProgressAtomic(dest, text, join(dirname(dest), ".tmp"));
    if (shouldIngest(parsed)) {
      await ingestProgress(ctx);
    }
  } finally {
    release();
  }
}

export async function markStep(
  ctx: PlatformContext,
  stepId: string,
  status: StepStatus,
  extra?: { command_key?: string },
): Promise<CoordinatorRecord> {
  if (!(STEP_STATUSES as readonly string[]).includes(status)) {
    throw new PluginError("usage", `Invalid step status ${String(status)}`);
  }
  const record = await loadCoordinator(ctx);
  const step = record.steps.find((s) => s.id === stepId);
  if (!step) {
    throw new PluginError("not_found", `Step not found: ${stepId}`);
  }
  step.status = status;
  if (extra?.command_key) {
    step.command_key = extra.command_key;
  }
  const at = new Date().toISOString();
  const ev: ProgressEvent = { step_title: step.step_title, status, at };
  if (extra?.command_key) {
    ev.command_key = extra.command_key;
  } else if (step.command_key) {
    ev.command_key = step.command_key;
  }
  record.events.push(ev);
  record.updated_at = at;
  record.resume_step_id = resumeAfterMark(record, stepId, status);
  await saveCoordinator(ctx, record);
  return record;
}
