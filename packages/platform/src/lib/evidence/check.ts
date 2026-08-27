import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { PlatformContext } from "../context.js";
import { logPlatform } from "../log.js";
import type { EnvMap } from "../paths.js";
import { splitArgv } from "../playbook/normalize.js";
import { playbookList, playbookRecord } from "../playbook/store.js";
import type { PurposeTag } from "../playbook/types.js";
import { redactArgv, redactText } from "../redact.js";

export type EvidenceInput = {
  command?: string;
  argv?: string[];
  purpose?: PurposeTag | string;
  force?: boolean;
  cwd?: string;
  timeout_ms?: number;
  retries?: number;
};

export type EvidenceVerdict = "pass" | "fail" | "no_command" | "denied" | "error" | "skipped";

export type EvidenceResult = {
  ok: boolean;
  verdict: EvidenceVerdict;
  command: string | null;
  attempts: number;
  exit_code: number | null;
  duration_ms: number;
  tail: string;
  recorded: "stored" | "excluded" | "redacted" | "skipped";
  resolved_level: "off" | "light" | "full";
  timed_out: boolean;
};

export type EvidenceSpawnCall = {
  file: string;
  args: string[];
  shell: boolean;
  cwd: string;
  target: string;
};

/** Tests assert spawn argv and that denied commands never start a child. */
export const evidenceSpawnCalls: EvidenceSpawnCall[] = [];

const SECRET_ENV_KEYS = new Set([
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NPM_TOKEN",
]);
const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|API_KEY)$/i;
const DENY_PHRASES = [
  "rm -rf /",
  "rm -rf //",
  "rm -- /",
  "rm -rf ~",
  "diskutil erase",
  "format ",
  "curl | sh",
  "wget | sh",
] as const;
const CAPTURE_MAX = 262_144;
const DEFAULT_PATHEXT = ".EXE;.CMD;.BAT;.COM";
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM_RE = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

type ChildRun = {
  status: number | null;
  merged: string;
  timedOut: boolean;
  spawnError: boolean;
};

function emptyResult(
  level: EvidenceResult["resolved_level"],
  extra: Partial<EvidenceResult>,
): EvidenceResult {
  return {
    ok: false,
    verdict: "error",
    command: null,
    attempts: 0,
    exit_code: null,
    duration_ms: 0,
    tail: "",
    recorded: "skipped",
    resolved_level: level,
    timed_out: false,
    ...extra,
  };
}

function displayCommand(argv: string[]): string {
  return redactArgv(argv).argv.join(" ");
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(delimiter).filter((p) => p.length > 0);
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(tryRealpath(root), tryRealpath(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSep(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

function hasExt(token: string): boolean {
  const base = basename(token);
  const i = base.lastIndexOf(".");
  return i > 0;
}

function pathextSuffixes(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT && env.PATHEXT.trim() ? env.PATHEXT : DEFAULT_PATHEXT;
  const list = raw
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map((e) => (e.startsWith(".") ? e : `.${e}`));
  const exe: string[] = [];
  const rest: string[] = [];
  for (const e of list) {
    if (e.toLowerCase() === ".exe") {
      exe.push(e);
    } else {
      rest.push(e);
    }
  }
  return [...exe, ...rest];
}

function allowedBin(real: string, repoPath: string, env: NodeJS.ProcessEnv): boolean {
  if (isInside(repoPath, real)) {
    return true;
  }
  for (const dir of pathDirs(env)) {
    if (isInside(dir, real)) {
      return true;
    }
  }
  return false;
}

function resolveArgv0(
  argv0: string,
  cwd: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (hasPathSep(argv0)) {
    const abs = isAbsolute(argv0) ? argv0 : resolve(cwd, argv0);
    if (!isExecutableFile(abs)) {
      return undefined;
    }
    const real = tryRealpath(abs);
    // Jail the target so a repo link to the outside does not run.
    return allowedBin(real, repoPath, env) ? abs : undefined;
  }

  const suffixes =
    process.platform === "win32" && !hasExt(argv0) ? ["", ...pathextSuffixes(env)] : [""];
  for (const dir of pathDirs(env)) {
    for (const suf of suffixes) {
      const cand = join(dir, `${argv0}${suf}`);
      if (!isExecutableFile(cand)) {
        continue;
      }
      // PATH hit is already in a PATH dir. Do not jail the symlink target.
      return cand;
    }
  }
  return undefined;
}

function isWinBatch(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
}

function escapeCmdCommand(arg: string): string {
  return arg.replace(CMD_META_RE, "^$1");
}

function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let s = String(arg);
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, "$1$1");
  s = `"${s}"`;
  s = s.replace(CMD_META_RE, "^$1");
  if (doubleEscape) {
    s = s.replace(CMD_META_RE, "^$1");
  }
  return s;
}

function cmdExe(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.ComSpec || env.comspec || env.COMSPEC;
  if (fromEnv && isExecutableFile(fromEnv)) {
    return fromEnv;
  }
  for (const dir of pathDirs(env)) {
    const cand = join(dir, "cmd.exe");
    if (isExecutableFile(cand)) {
      return cand;
    }
  }
  return "cmd.exe";
}

function wrapSpawn(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; verbatim: boolean } {
  if (!isWinBatch(file)) {
    return { file, args, verbatim: false };
  }
  // Node 20+ rejects spawn(.cmd, { shell: false }). cmd.exe keeps shell false.
  const double = CMD_SHIM_RE.test(file);
  const line = [escapeCmdCommand(file), ...args.map((a) => escapeCmdArgument(a, double))].join(" ");
  return {
    file: cmdExe(env),
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

function isDeniedCommand(argv: string[], rawCommand?: string): boolean {
  const blobs = [argv.join(" ")];
  if (rawCommand !== undefined) {
    blobs.push(rawCommand);
  }
  for (const text of blobs) {
    for (const phrase of DENY_PHRASES) {
      if (text.includes(phrase)) {
        return true;
      }
    }
    if (text.includes("dd if=") && text.includes("of=/dev")) {
      return true;
    }
    if (/(^|[\s;|&])mkfs/.test(text)) {
      return true;
    }
    // $(reboot) is one token; a bare substring would deny it before ENOENT.
    if (/(^|[\s;|&])(shutdown|reboot)([\s;|&]|$)/.test(text)) {
      return true;
    }
  }
  return false;
}

function scrubEnv(env: EnvMap): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v === undefined) {
      continue;
    }
    if (k.startsWith("DEVKIT_")) {
      continue;
    }
    if (SECRET_ENV_KEYS.has(k) || SECRET_ENV_RE.test(k)) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function jailCwd(repoPath: string, cwd: string | undefined): string | undefined {
  const raw = cwd && cwd.trim() ? cwd.trim() : repoPath;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(repoPath, raw);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return undefined;
  }
  if (!isInside(repoPath, real)) {
    return undefined;
  }
  return real;
}

function takeTail(text: string, maxLines: number, maxBytes: number): string {
  const lines = redactText(text).split(/\r?\n/);
  const last = lines.slice(-maxLines).join("\n");
  const buf = Buffer.from(last, "utf8");
  if (buf.length <= maxBytes) {
    return last;
  }
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // child already gone
    }
  }
}

function appendCapture(prev: string, chunk: Buffer): string {
  const next = prev + chunk.toString("utf8");
  if (next.length <= CAPTURE_MAX) {
    return next;
  }
  return next.slice(-Math.floor(CAPTURE_MAX / 4));
}

function runChild(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; verbatim?: boolean },
): Promise<ChildRun> {
  return new Promise((resolvePromise) => {
    let done = false;
    let timedOut = false;
    let spawnError = false;
    let merged = "";
    // detached so timeout can kill the group
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: Boolean(opts.verbatim),
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      merged = appendCapture(merged, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      merged = appendCapture(merged, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    const finish = (status: number | null) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolvePromise({ status, merged, timedOut, spawnError });
    };
    child.on("error", () => {
      spawnError = true;
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

async function argvFromPlaybook(
  ctx: PlatformContext,
  purpose: string,
  force: boolean,
): Promise<string[] | undefined> {
  const rows = await playbookList(ctx, ctx.config.playbook.max_entries);
  for (const row of rows) {
    if (!row.purpose_tags.includes(purpose as PurposeTag)) {
      continue;
    }
    if (!force && row.last_status === "fail") {
      continue;
    }
    if (row.argv.length === 0) {
      continue;
    }
    return row.argv.slice();
  }
  return undefined;
}

async function resolveArgv(
  ctx: PlatformContext,
  input: EvidenceInput,
): Promise<string[] | undefined> {
  if (input.argv && input.argv.length > 0) {
    return input.argv.slice();
  }
  const raw = input.command?.trim();
  if (raw) {
    const split = splitArgv(raw);
    if (split.length > 0) {
      return split;
    }
  }
  const purpose = input.purpose?.trim();
  if (purpose) {
    return argvFromPlaybook(ctx, purpose, Boolean(input.force));
  }
  return undefined;
}

export async function evidenceCheck(
  ctx: PlatformContext,
  input: EvidenceInput,
): Promise<EvidenceResult> {
  evidenceSpawnCalls.length = 0;
  const level = ctx.config.resolved_level;
  const started = Date.now();

  if (level === "off") {
    return emptyResult(level, { ok: true, verdict: "skipped" });
  }

  const argv = await resolveArgv(ctx, input);
  if (!argv || argv.length === 0) {
    const out = emptyResult(level, { verdict: "no_command" });
    logPlatform(ctx.env, {
      component: "evidence",
      event: "evidence_check",
      repo_id: ctx.repoId,
      result: out.verdict,
      duration_ms: Date.now() - started,
    });
    return out;
  }

  const shown = displayCommand(argv);
  if (isDeniedCommand(argv, input.command)) {
    const out = emptyResult(level, { verdict: "denied", command: shown });
    logPlatform(ctx.env, {
      component: "evidence",
      event: "evidence_check",
      repo_id: ctx.repoId,
      result: out.verdict,
      duration_ms: Date.now() - started,
    });
    return out;
  }

  const jailed = jailCwd(ctx.repoPath, input.cwd);
  if (!jailed) {
    return emptyResult(level, {
      verdict: "error",
      command: shown,
      duration_ms: Date.now() - started,
    });
  }

  const childEnv = scrubEnv(ctx.env);
  const argv0 = argv[0];
  if (!argv0) {
    return emptyResult(level, { verdict: "no_command" });
  }
  const file = resolveArgv0(argv0, jailed, ctx.repoPath, childEnv);
  if (!file) {
    return emptyResult(level, {
      verdict: "error",
      command: shown,
      duration_ms: Date.now() - started,
    });
  }

  const timeoutMs = input.timeout_ms ?? ctx.config.platform.evidence.timeout_ms;
  const tailLines = ctx.config.platform.evidence.tail_lines;
  const tailBytes = ctx.config.platform.evidence.tail_bytes;
  const retryCount =
    input.retries !== undefined ? input.retries : ctx.config.verification.evidence_retries;
  const maxAttempts = Math.max(1, retryCount + 1);
  const args = argv.slice(1);

  let attempts = 0;
  let lastStatus: number | null = null;
  let lastTail = "";
  let verdict: EvidenceVerdict = "fail";
  let spawnFailed = false;
  let timedOut = false;

  for (let i = 0; i < maxAttempts; i++) {
    const wrapped = wrapSpawn(file, args, childEnv);
    evidenceSpawnCalls.push({
      file: wrapped.file,
      args: wrapped.args,
      shell: false,
      cwd: jailed,
      target: file,
    });
    attempts += 1;
    const run = await runChild(wrapped.file, wrapped.args, {
      cwd: jailed,
      env: childEnv,
      timeoutMs,
      verbatim: wrapped.verbatim,
    });
    lastTail = takeTail(run.merged, tailLines, tailBytes);
    if (run.spawnError && !run.timedOut) {
      spawnFailed = true;
      lastStatus = null;
      verdict = "error";
      break;
    }
    if (run.timedOut) {
      lastStatus = null;
      verdict = "fail";
      timedOut = true;
      continue;
    }
    timedOut = false;
    lastStatus = run.status;
    if (run.status === 0) {
      verdict = "pass";
      break;
    }
    verdict = "fail";
  }

  const duration_ms = Date.now() - started;
  let recorded: EvidenceResult["recorded"] = "skipped";
  if (attempts > 0 && (verdict === "pass" || verdict === "fail") && !spawnFailed) {
    const rec = await playbookRecord(ctx, {
      raw_command: argv.join(" "),
      tool_name: "Bash",
      cwd: jailed,
      exit_code: lastStatus ?? 1,
      duration_ms,
    });
    recorded = rec.result;
  }

  const out: EvidenceResult = {
    ok: verdict === "pass",
    verdict,
    command: shown,
    attempts,
    exit_code: lastStatus,
    duration_ms,
    tail: lastTail,
    recorded,
    resolved_level: level,
    timed_out: timedOut,
  };
  logPlatform(ctx.env, {
    component: "evidence",
    event: "evidence_check",
    repo_id: ctx.repoId,
    result: out.verdict,
    duration_ms,
  });
  return out;
}

export const evidence_check = evidenceCheck;
