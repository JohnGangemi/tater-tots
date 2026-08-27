import { compress, decompress } from "@mongodb-js/zstd";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";
import { applyUserOnlyFileSync, writeFileAtomic } from "../fs-atomic.js";
import { logPlatform } from "../log.js";
import type { EnvMap } from "../paths.js";
import { redactArgv } from "../redact.js";
import { evictToMax } from "./lru.js";
import { makeKey, normalizeObserve, purposeTags } from "./normalize.js";
import {
  LOOKUP_CAP,
  PURPOSE_TAGS,
  type LookupIn,
  type LookupOut,
  type ObserveEvent,
  type PlaybookEntry,
  type PlaybookFile,
  type PlaybookRecordResult,
  type PlaybookStatsOut,
  type PurposeTag,
} from "./types.js";
import { countSignals, isHardExcluded, isNamedExcludeTool, isWorthy } from "./worth.js";

export type {
  LookupHit,
  LookupIn,
  LookupOut,
  ObserveEvent,
  PlaybookEntry,
  PlaybookFile,
  PlaybookRecordResult,
  PlaybookStatsOut,
  PurposeTag,
} from "./types.js";

type LoadedPlaybook = {
  file: PlaybookFile;
  refuseWrites: boolean;
  readable: boolean;
};

function logEnv(ctx: PlatformContext): EnvMap {
  return ctx.env;
}

function emptyFile(repoId: string): PlaybookFile {
  return {
    version: 1,
    repo_id: repoId,
    updated_at: new Date().toISOString(),
    entries: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value;
}

function parseEntry(value: unknown): PlaybookEntry | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const key = asString(value.key);
  const command = asString(value.command);
  const argv = asStringArray(value.argv);
  const tags = asStringArray(value.purpose_tags);
  const lastStatus = value.last_status;
  const lastExit = asNumber(value.last_exit);
  const lastDuration = asNumber(value.last_duration_ms);
  const lastRunAt = asString(value.last_run_at);
  const firstSeenAt = asString(value.first_seen_at);
  const lruAt = asString(value.lru_at);
  const runCount = asNumber(value.run_count);
  const failCount = asNumber(value.fail_count);
  if (
    !key ||
    command === undefined ||
    !argv ||
    !tags ||
    (lastStatus !== "pass" && lastStatus !== "fail") ||
    lastExit === undefined ||
    lastDuration === undefined ||
    !lastRunAt ||
    !firstSeenAt ||
    !lruAt ||
    runCount === undefined ||
    failCount === undefined
  ) {
    return undefined;
  }
  const cwdRaw = value.cwd_rel;
  const cwd_rel = cwdRaw === null || typeof cwdRaw === "string" ? cwdRaw : null;
  return {
    key,
    command,
    argv,
    purpose_tags: tags.filter((t): t is PurposeTag => (PURPOSE_TAGS as string[]).includes(t)),
    cwd_rel,
    last_status: lastStatus,
    last_exit: lastExit,
    last_duration_ms: lastDuration,
    last_run_at: lastRunAt,
    first_seen_at: firstSeenAt,
    lru_at: lruAt,
    run_count: runCount,
    fail_count: failCount,
  };
}

function parsePlaybook(raw: unknown): { file?: PlaybookFile; versionBad: boolean } {
  if (!isPlainObject(raw)) {
    return { versionBad: false };
  }
  if (typeof raw.version !== "number") {
    return { versionBad: false };
  }
  if (raw.version !== 1) {
    return { versionBad: true };
  }
  if (!Array.isArray(raw.entries)) {
    return { versionBad: false };
  }
  const repo_id = asString(raw.repo_id) ?? "";
  const updated_at = asString(raw.updated_at) ?? new Date().toISOString();
  const entries: PlaybookEntry[] = [];
  for (const item of raw.entries) {
    const entry = parseEntry(item);
    if (entry) {
      entries.push(entry);
    }
  }
  return { file: { version: 1, repo_id, updated_at, entries }, versionBad: false };
}

function copyBak(ctx: PlatformContext): void {
  try {
    if (existsSync(ctx.paths.playbookFile)) {
      copyFileSync(ctx.paths.playbookFile, ctx.paths.playbookBakFile);
      applyUserOnlyFileSync(ctx.paths.playbookBakFile);
    }
  } catch {
    // bak copy is best-effort; writes stay refused
  }
}

function resetRequested(ctx: PlatformContext): boolean {
  return ctx.env.DEVKIT_PLAYBOOK_RESET === "1";
}

async function loadPlaybook(ctx: PlatformContext): Promise<LoadedPlaybook> {
  const reset = resetRequested(ctx);
  const bakExists = existsSync(ctx.paths.playbookBakFile);
  if (!existsSync(ctx.paths.playbookFile)) {
    return { file: emptyFile(ctx.repoId), refuseWrites: bakExists && !reset, readable: false };
  }
  try {
    const buf = await readFile(ctx.paths.playbookFile);
    const jsonBuf = await decompress(buf);
    const parsed: unknown = JSON.parse(jsonBuf.toString("utf8"));
    const { file, versionBad } = parsePlaybook(parsed);
    if (versionBad) {
      logPlatform(logEnv(ctx), {
        component: "playbook",
        event: "playbook_version_unsupported",
        repo_id: ctx.repoId,
      });
      return { file: emptyFile(ctx.repoId), refuseWrites: !reset, readable: false };
    }
    if (!file) {
      throw new Error("playbook json");
    }
    return { file, refuseWrites: bakExists && !reset, readable: true };
  } catch {
    copyBak(ctx);
    logPlatform(logEnv(ctx), {
      component: "playbook",
      event: "playbook_corrupt",
      repo_id: ctx.repoId,
    });
    return { file: emptyFile(ctx.repoId), refuseWrites: !reset, readable: false };
  }
}

async function writePlaybook(ctx: PlatformContext, file: PlaybookFile): Promise<void> {
  const next: PlaybookFile = {
    version: 1,
    repo_id: ctx.repoId,
    updated_at: new Date().toISOString(),
    entries: file.entries,
  };
  const buf = Buffer.from(JSON.stringify(next), "utf8");
  const zst = await compress(buf, 3);
  await writeFileAtomic(ctx.paths.playbookFile, zst);
  if (resetRequested(ctx) && existsSync(ctx.paths.playbookBakFile)) {
    try {
      unlinkSync(ctx.paths.playbookBakFile);
    } catch {
      // bak may already be gone
    }
  }
}

function assertWritable(loaded: LoadedPlaybook): void {
  if (loaded.refuseWrites) {
    throw new PlatformError("io", "Playbook writes are refused until DEVKIT_PLAYBOOK_RESET=1");
  }
}

function toHit(entry: PlaybookEntry): LookupOut["commands"][number] {
  return {
    command: entry.command,
    last_status: entry.last_status,
    last_exit: entry.last_exit,
    run_count: entry.run_count,
    purpose_tags: entry.purpose_tags,
  };
}

function upsertEntry(
  file: PlaybookFile,
  entry: Omit<PlaybookEntry, "first_seen_at" | "run_count" | "fail_count"> & {
    fail: boolean;
  },
): void {
  const idx = file.entries.findIndex((e) => e.key === entry.key);
  if (idx >= 0) {
    const prev = file.entries[idx];
    if (!prev) {
      return;
    }
    file.entries[idx] = {
      ...prev,
      command: entry.command,
      argv: entry.argv,
      purpose_tags: entry.purpose_tags,
      cwd_rel: entry.cwd_rel,
      last_status: entry.last_status,
      last_exit: entry.last_exit,
      last_duration_ms: entry.last_duration_ms,
      last_run_at: entry.last_run_at,
      lru_at: entry.lru_at,
      run_count: prev.run_count + 1,
      fail_count: prev.fail_count + (entry.fail ? 1 : 0),
    };
    return;
  }
  file.entries.push({
    key: entry.key,
    command: entry.command,
    argv: entry.argv,
    purpose_tags: entry.purpose_tags,
    cwd_rel: entry.cwd_rel,
    last_status: entry.last_status,
    last_exit: entry.last_exit,
    last_duration_ms: entry.last_duration_ms,
    last_run_at: entry.last_run_at,
    first_seen_at: entry.last_run_at,
    lru_at: entry.lru_at,
    run_count: 1,
    fail_count: entry.fail ? 1 : 0,
  });
}

export async function playbookRecord(
  ctx: PlatformContext,
  ev: ObserveEvent,
): Promise<PlaybookRecordResult> {
  if (isNamedExcludeTool(ev.tool_name)) {
    logPlatform(logEnv(ctx), {
      component: "playbook",
      event: "playbook_record",
      repo_id: ctx.repoId,
      result: "excluded",
    });
    return { result: "excluded" };
  }

  const norm = normalizeObserve(ev, ctx.repoPath);
  if (!norm) {
    logPlatform(logEnv(ctx), {
      component: "playbook",
      event: "playbook_record",
      repo_id: ctx.repoId,
      result: "excluded",
    });
    return { result: "excluded" };
  }

  const redacted = redactArgv(norm.argv);
  if (redacted.drop) {
    logPlatform(logEnv(ctx), {
      component: "playbook",
      event: "playbook_record",
      repo_id: ctx.repoId,
      result: "redacted",
    });
    return { result: "redacted" };
  }

  const argv = redacted.argv;
  const command = argv.join(" ");
  const key = makeKey(argv);
  const tags = purposeTags(argv);

  if (isHardExcluded(argv, ev.tool_name)) {
    logPlatform(logEnv(ctx), {
      component: "playbook",
      event: "playbook_record",
      repo_id: ctx.repoId,
      result: "excluded",
      key,
    });
    return { result: "excluded" };
  }

  const loaded = await loadPlaybook(ctx);
  const existingKeys = new Set(loaded.file.entries.map((e) => e.key));
  const signals = countSignals({
    argv,
    rawCommand: ev.raw_command ?? command,
    durationMs: ev.duration_ms,
    exitCode: ev.exit_code,
    repoPath: ctx.repoPath,
    key,
    existingKeys,
  });
  if (!isWorthy(ctx.config.playbook.filter, argv, ev.tool_name, tags, signals)) {
    logPlatform(logEnv(ctx), {
      component: "playbook",
      event: "playbook_record",
      repo_id: ctx.repoId,
      result: "excluded",
      key,
    });
    return { result: "excluded" };
  }

  const exit = ev.exit_code ?? 0;
  const fail = exit !== 0;
  if (fail && !ctx.config.playbook.keep_failures) {
    logPlatform(logEnv(ctx), {
      component: "playbook",
      event: "playbook_record",
      repo_id: ctx.repoId,
      result: "excluded",
      key,
    });
    return { result: "excluded" };
  }

  assertWritable(loaded);

  const now = new Date().toISOString();
  upsertEntry(loaded.file, {
    key,
    command,
    argv,
    purpose_tags: tags,
    cwd_rel: norm.cwd_rel,
    last_status: fail ? "fail" : "pass",
    last_exit: exit,
    last_duration_ms: ev.duration_ms ?? 0,
    last_run_at: now,
    lru_at: now,
    fail,
  });
  loaded.file.entries = evictToMax(loaded.file.entries, ctx.config.playbook.max_entries);
  await writePlaybook(ctx, loaded.file);
  logPlatform(logEnv(ctx), {
    component: "playbook",
    event: "playbook_record",
    repo_id: ctx.repoId,
    result: "stored",
    key,
  });
  return { result: "stored" };
}

export const playbook_record = playbookRecord;

export async function playbookLookup(ctx: PlatformContext, q: LookupIn): Promise<LookupOut> {
  const loaded = await loadPlaybook(ctx);
  let rows = loaded.file.entries.slice();
  if (q.purpose) {
    rows = rows.filter((e) => e.purpose_tags.includes(q.purpose as PurposeTag));
  }
  const prefix = q.prefix;
  if (prefix) {
    rows = rows.filter((e) => e.key.startsWith(prefix) || e.command.startsWith(prefix));
  }
  rows.sort((a, b) => {
    if (a.lru_at < b.lru_at) {
      return 1;
    }
    if (a.lru_at > b.lru_at) {
      return -1;
    }
    return 0;
  });
  const top = rows.slice(0, LOOKUP_CAP);
  if (top.length > 0 && !loaded.refuseWrites) {
    const now = new Date().toISOString();
    const keys = new Set(top.map((e) => e.key));
    for (const entry of loaded.file.entries) {
      if (keys.has(entry.key)) {
        entry.lru_at = now;
      }
    }
    try {
      await writePlaybook(ctx, loaded.file);
    } catch {
      // lookup still returns hits if the lru write fails
    }
  }
  return { commands: top.map(toHit) };
}

export async function playbookList(ctx: PlatformContext, limit: number): Promise<PlaybookEntry[]> {
  const loaded = await loadPlaybook(ctx);
  const rows = loaded.file.entries.slice().sort((a, b) => {
    if (a.lru_at < b.lru_at) {
      return 1;
    }
    if (a.lru_at > b.lru_at) {
      return -1;
    }
    return 0;
  });
  return rows.slice(0, limit);
}

export async function playbookStats(ctx: PlatformContext): Promise<PlaybookStatsOut> {
  const loaded = await loadPlaybook(ctx);
  const by_purpose = {
    test: 0,
    build: 0,
    lint: 0,
    migrate: 0,
    publish: 0,
    run: 0,
    other: 0,
  } satisfies Record<PurposeTag, number>;
  let pass = 0;
  let fail = 0;
  for (const entry of loaded.file.entries) {
    if (entry.last_status === "pass") {
      pass += 1;
    } else {
      fail += 1;
    }
    for (const tag of entry.purpose_tags) {
      by_purpose[tag] += 1;
    }
  }
  return {
    entries: loaded.file.entries.length,
    max_entries: ctx.config.playbook.max_entries,
    filter: ctx.config.playbook.filter,
    last_updated: loaded.readable ? loaded.file.updated_at : null,
    by_purpose,
    pass,
    fail,
  };
}
