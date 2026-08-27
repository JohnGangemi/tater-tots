import { existsSync, readFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import {
  formatSessionStartOutput,
  formatStopBlock,
  formatStopUserReminder,
  parseClaudeHookInput,
  type ClaudeHookInput,
  type HookKind,
} from "./adapters/claude-code.js";
import { createContext, type PlatformContext } from "./lib/context.js";
import { evidenceCheck } from "./lib/evidence/check.js";
import { isPlatformError } from "./lib/errors.js";
import { writeFileAtomicSync } from "./lib/fs-atomic.js";
import { cbmCli } from "./lib/graph/cbm-client.js";
import { readCbmMapping } from "./lib/graph/init.js";
import { isClaimedCompletion } from "./lib/hooks/claimed-completion.js";
import { skillNamesFromTranscript } from "./lib/hooks/transcript.js";
import { logPlatform } from "./lib/log.js";
import type { EnvMap } from "./lib/paths.js";
import { redactText } from "./lib/redact.js";
import { playbookRecord, playbookStats } from "./lib/playbook/store.js";

export const SESSION_START_BUDGET_MS = 200;
export const STOP_EVIDENCE_TIMEOUT_MS = 20_000;

const POINTER_TOOLS =
  "graph_search, graph_symbol, graph_impact, playbook_lookup, evidence_check, adversarial_review, tune_status";
const POINTER_MAX_LINES = 20;
const OBSERVE_TOOL = "Bash";
const STOP_PURPOSES = ["test", "build", "lint"] as const;

const HOOK_KINDS = new Set<string>(["session-start", "post-tool-use", "stop"]);

export type HookIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
};

export type RunHookCommandOpts = {
  rest: string[];
  env: EnvMap;
  io: HookIo;
  path?: string;
  config?: string;
  verification?: string;
};

type SessionPointer = {
  session_id: string;
  repo_id: string;
  skills: string[];
};

function failOpenLog(env: EnvMap, err: unknown): void {
  logPlatform(env, {
    component: "hook",
    event: "hook_fail_open",
    ...(isPlatformError(err) ? { code: err.code } : { code: "internal" }),
  });
}

function asKind(value: string | undefined): HookKind | undefined {
  if (value && HOOK_KINDS.has(value)) {
    return value as HookKind;
  }
  return undefined;
}

async function readStdin(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) {
    return "";
  }
  return text(stream);
}

function parsePayload(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function capLines(textValue: string, max: number): string {
  const lines = textValue.split("\n");
  if (lines.length <= max) {
    return textValue;
  }
  return lines.slice(0, max).join("\n");
}

function buildPointer(
  graph: string,
  repoId: string,
  playbook: string,
  verification: string,
): string {
  return capLines(
    [
      "CoreDevKit platform",
      `graph: ${graph}`,
      `repo_id: ${repoId}`,
      `playbook_entries: ${playbook}`,
      `verification: ${verification}`,
      `tools: ${POINTER_TOOLS}`,
      "Prefer graph tools over a full-repo walk.",
      "Prefer playbook_lookup for test/build/lint.",
      "Call evidence_check before claiming done when verification is on.",
    ].join("\n"),
    POINTER_MAX_LINES,
  );
}

function onAbort<T>(signal: AbortSignal, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(fallback);
      return;
    }
    signal.addEventListener("abort", () => resolve(fallback), { once: true });
  });
}

async function sessionGraphState(
  ctx: PlatformContext,
  budgetMs: number,
  signal: AbortSignal,
): Promise<string> {
  try {
    await cbmCli(
      ctx,
      "list_projects",
      { "include-details": true, limit: 1, offset: 0 },
      { timeoutMs: budgetMs, signal },
    );
    if (signal.aborted) {
      return "unknown";
    }
    const mapping = readCbmMapping(ctx.paths.cbmProjectFile);
    if (!mapping) {
      return "missing";
    }
    return mapping.last_status === "degraded" ? "degraded" : "ready";
  } catch (err) {
    if (signal.aborted || (isPlatformError(err) && err.code === "graph_timeout")) {
      return "unknown";
    }
    return "missing";
  }
}

async function sessionPlaybookEntries(ctx: PlatformContext, signal: AbortSignal): Promise<string> {
  try {
    const stats = await Promise.race([
      playbookStats(ctx),
      onAbort(signal, undefined).then(() => undefined),
    ]);
    if (stats === undefined || signal.aborted) {
      return "?";
    }
    return String(stats.entries);
  } catch {
    return "0";
  }
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter((n) => n.length > 0))];
}

function payloadSkills(payload: ClaudeHookInput): string[] {
  const fromTranscript = payload.transcriptPath
    ? skillNamesFromTranscript(payload.transcriptPath)
    : [];
  return uniqueNames([...payload.skills, ...fromTranscript]);
}

function writeSessionPointer(ctx: PlatformContext, payload: ClaudeHookInput): void {
  const pointer: SessionPointer = {
    session_id: payload.sessionId,
    repo_id: ctx.repoId,
    skills: payloadSkills(payload),
  };
  writeFileAtomicSync(ctx.paths.sessionPointerFile, `${JSON.stringify(pointer)}\n`);
}

function readSessionPointer(ctx: PlatformContext): SessionPointer | undefined {
  if (!existsSync(ctx.paths.sessionPointerFile)) {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(ctx.paths.sessionPointerFile, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return undefined;
    }
    const obj = raw as Record<string, unknown>;
    const skills = Array.isArray(obj.skills)
      ? obj.skills.filter((item): item is string => typeof item === "string")
      : [];
    return {
      session_id: typeof obj.session_id === "string" ? obj.session_id : "",
      repo_id: typeof obj.repo_id === "string" ? obj.repo_id : "",
      skills,
    };
  } catch {
    return undefined;
  }
}

async function runSessionStart(
  ctx: PlatformContext,
  payload: ClaudeHookInput,
  io: HookIo,
): Promise<void> {
  const signal = AbortSignal.timeout(SESSION_START_BUDGET_MS);
  const [graph, playbook] = await Promise.all([
    sessionGraphState(ctx, SESSION_START_BUDGET_MS, signal),
    sessionPlaybookEntries(ctx, signal),
  ]);
  const pointer = buildPointer(graph, ctx.repoId, playbook, ctx.config.resolved_level);
  try {
    writeSessionPointer(ctx, payload);
  } catch {
    // Pointer is for Stop skip_skills only; still emit the short SessionStart text.
  }
  io.stdout.write(formatSessionStartOutput(pointer));
}

async function runPostToolUse(ctx: PlatformContext, payload: ClaudeHookInput): Promise<void> {
  if (!ctx.config.platform.observe_bash) {
    return;
  }
  if (payload.toolName !== OBSERVE_TOOL) {
    return;
  }
  if (!payload.command) {
    return;
  }
  await playbookRecord(ctx, {
    raw_command: payload.command,
    tool_name: OBSERVE_TOOL,
    cwd: payload.cwd || ctx.repoPath,
    exit_code: payload.exitCode,
    duration_ms: payload.durationMs,
    ...(payload.sessionId ? { session_id: payload.sessionId } : {}),
  });
}

function pointerSkillsForStop(ctx: PlatformContext, payload: ClaudeHookInput): string[] {
  const pointer = readSessionPointer(ctx);
  if (!pointer) {
    return [];
  }
  if (pointer.session_id !== payload.sessionId || pointer.repo_id !== ctx.repoId) {
    return [];
  }
  return pointer.skills;
}

function skillNames(ctx: PlatformContext, payload: ClaudeHookInput): string[] {
  return uniqueNames([...payloadSkills(payload), ...pointerSkillsForStop(ctx, payload)]);
}

function isSkippedSkill(ctx: PlatformContext, names: string[]): boolean {
  const skip = ctx.config.platform.skip_skills;
  if (skip.length === 0 || names.length === 0) {
    return false;
  }
  const set = new Set(skip);
  return names.some((name) => set.has(name));
}

async function runStopEvidence(ctx: PlatformContext, io: HookIo): Promise<void> {
  const started = Date.now();
  for (const purpose of STOP_PURPOSES) {
    const left = STOP_EVIDENCE_TIMEOUT_MS - (Date.now() - started);
    if (left <= 0) {
      return;
    }
    const timeoutMs = Math.min(left, ctx.config.platform.evidence.timeout_ms);
    const result = await evidenceCheck(ctx, {
      purpose,
      timeout_ms: timeoutMs,
      retries: 0,
    });
    if (result.verdict === "no_command" || result.verdict === "skipped") {
      continue;
    }
    if (result.timed_out || result.verdict === "error") {
      return;
    }
    if (!result.ok) {
      const shown = result.command ? redactText(result.command) : "<redacted>";
      io.stdout.write(formatStopBlock(`evidence_check failed for ${shown}`));
      return;
    }
  }
}

async function runStop(ctx: PlatformContext, payload: ClaudeHookInput, io: HookIo): Promise<void> {
  const claimed = isClaimedCompletion({
    stopHookActive: payload.stopHookActive,
    lastAssistantMessage: payload.lastAssistantMessage || undefined,
    transcriptPath: payload.transcriptPath || undefined,
  });
  if (!claimed) {
    return;
  }
  if (!ctx.config.platform.evidence_on_stop || ctx.config.resolved_level === "off") {
    return;
  }
  if (isSkippedSkill(ctx, skillNames(ctx, payload))) {
    return;
  }
  if (!ctx.config.platform.stop_blocking) {
    io.stdout.write(formatStopUserReminder());
    return;
  }
  await runStopEvidence(ctx, io);
}

export async function runHookCommand(opts: RunHookCommandOpts): Promise<void> {
  const env = opts.env;
  try {
    const kind = asKind(opts.rest[0]);
    if (!kind) {
      return;
    }
    const raw = await readStdin(opts.io.stdin);
    const json = parsePayload(raw);
    if (!json) {
      return;
    }
    const payload = parseClaudeHookInput(json);
    if (!payload) {
      return;
    }
    const repoPath = opts.path?.trim() || payload.cwd;
    const ctx = await createContext({
      repoPath,
      ...(opts.config ? { configFile: opts.config } : {}),
      ...(opts.verification ? { verification: opts.verification } : {}),
      env,
    });
    if (kind === "session-start") {
      await runSessionStart(ctx, payload, opts.io);
      return;
    }
    if (kind === "post-tool-use") {
      await runPostToolUse(ctx, payload);
      return;
    }
    await runStop(ctx, payload, opts.io);
  } catch (err) {
    failOpenLog(env, err);
  }
}
