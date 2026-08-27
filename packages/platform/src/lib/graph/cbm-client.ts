import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";
import type { EnvMap } from "../paths.js";
import {
  CBM_MIN_VERSION,
  CBM_MIN_VERSION_PARTS,
  cbmBinaryName,
  isCbmCommandName,
} from "./cbm-release.js";

export type CbmMcpEnvelope = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export type CbmFlags = Record<string, string | number | boolean | undefined>;

export type CbmCliOpts = {
  timeoutMs: number;
  binary?: string;
  signal?: AbortSignal;
};

export type CbmDiscoverOpts = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const ADMISSION_RE = /admission|exact-build|daemon-conflicts|CBM_CACHE_DIR/i;
const SAME_BINARY_HINT =
  "use the same codebase-memory-mcp binary as the running CBM MCP; close other CBM sessions or set platform.graph.binary";
const MISSING_HINT = "run devkit init in a terminal";
const VERSION_TIMEOUT_MS = 10_000;

export function graphUnavailable(message: string, hint?: string): PlatformError {
  return new PlatformError("graph_unavailable", message, hint);
}

export function graphTimeout(message: string, hint?: string): PlatformError {
  return new PlatformError("graph_timeout", message, hint);
}

export function unwrapCbmJson(stdout: string): unknown {
  let env: unknown;
  try {
    env = JSON.parse(stdout) as unknown;
  } catch {
    throw graphUnavailable("cbm stdout is not JSON");
  }
  const envelope = env as CbmMcpEnvelope;
  if (envelope && typeof envelope === "object" && envelope.isError === true) {
    const text = envelope.content?.[0]?.text ?? "";
    if (/timeout|timed out/i.test(text)) {
      throw graphTimeout(text);
    }
    throw graphUnavailable(text || "cbm isError");
  }
  if (
    envelope &&
    typeof envelope === "object" &&
    envelope.structuredContent !== null &&
    typeof envelope.structuredContent === "object" &&
    !Array.isArray(envelope.structuredContent)
  ) {
    return envelope.structuredContent;
  }
  const text = envelope?.content?.[0]?.text;
  if (typeof text === "string" && text.trim()) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw graphUnavailable("cbm content[0].text is not JSON");
    }
  }
  if (
    envelope &&
    typeof envelope === "object" &&
    !("content" in envelope) &&
    !("structuredContent" in envelope)
  ) {
    return envelope;
  }
  throw graphUnavailable("cbm stdout missing structuredContent and content[0].text");
}

export function encodeCbmFlags(flags: CbmFlags): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === false) {
      continue;
    }
    const flag = `--${key.replace(/^--/, "").replace(/_/g, "-")}`;
    if (value === true) {
      out.push(flag);
    } else {
      out.push(flag, String(value));
    }
  }
  return out;
}

function spawnEnv(env: EnvMap): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
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

function runCbm(
  binary: string,
  args: string[],
  opts: { timeoutMs: number; env: EnvMap; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    if (opts.signal?.aborted) {
      resolvePromise({ status: null, stdout: "", stderr: "", timedOut: true });
      return;
    }
    let done = false;
    let timedOut = false;
    // stdin ignore: CBM waits on an open stdin pipe. detached: timeout can kill the group.
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv(opts.env),
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const onAbort = () => {
      timedOut = true;
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort);
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
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    };
    child.on("error", () => {
      finish(-1);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

function parseVersionParts(text: string): [number, number, number] | undefined {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m || !m[1] || !m[2] || !m[3]) {
    return undefined;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionGte(
  got: [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    const a = got[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
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

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function homeOf(env: EnvMap): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function pathDirs(env: EnvMap): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(delimiter).filter((p) => p.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandsFromMcpJson(raw: unknown, repoPath?: string): string[] {
  const out: string[] = [];
  const take = (servers: unknown) => {
    if (!isPlainObject(servers)) {
      return;
    }
    for (const v of Object.values(servers)) {
      if (isPlainObject(v) && typeof v.command === "string") {
        out.push(v.command);
      }
    }
  };
  if (!isPlainObject(raw)) {
    return out;
  }
  take(raw.mcpServers ?? raw.mcp_servers);
  if (repoPath && isPlainObject(raw.projects)) {
    const proj = raw.projects[repoPath];
    if (isPlainObject(proj)) {
      take(proj.mcpServers ?? proj.mcp_servers);
    }
  }
  return out;
}

function commandsFromToml(text: string): string[] {
  const out: string[] = [];
  let mcpTable = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    const table = t.match(/^\[([^\]]+)\]/);
    if (table && table[1]) {
      mcpTable = table[1].toLowerCase().includes("mcp");
      continue;
    }
    if (!mcpTable || t.startsWith("#")) {
      continue;
    }
    const m = t.match(/^command\s*=\s*"(.*)"\s*$/) ?? t.match(/^command\s*=\s*'(.*)'\s*$/);
    if (m && m[1]) {
      out.push(m[1]);
    }
  }
  return out;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function mcpCommandPaths(ctx: PlatformContext): string[] {
  const env = ctx.env;
  const home = homeOf(env);
  const files: string[] = [join(ctx.repoPath, ".mcp.json"), join(home, ".claude.json")];
  const commands: string[] = [];
  const mcpJson = readText(files[0] ?? "");
  if (mcpJson) {
    try {
      commands.push(...commandsFromMcpJson(JSON.parse(mcpJson) as unknown, ctx.repoPath));
    } catch {
      // ignore bad project mcp json
    }
  }
  const claudeJson = readText(files[1] ?? "");
  if (claudeJson) {
    try {
      commands.push(...commandsFromMcpJson(JSON.parse(claudeJson) as unknown, ctx.repoPath));
    } catch {
      // ignore bad claude json
    }
  }
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  const toml = readText(join(codexHome, "config.toml"));
  if (toml) {
    commands.push(...commandsFromToml(toml));
  }
  const resolved: string[] = [];
  for (const cmd of commands) {
    if (!isCbmCommandName(cmd)) {
      continue;
    }
    if (isAbsolute(cmd)) {
      resolved.push(cmd);
      continue;
    }
    for (const dir of pathDirs(env)) {
      resolved.push(join(dir, cmd));
    }
  }
  return resolved;
}

function candidateBinaries(ctx: PlatformContext): string[] {
  const env = ctx.env;
  const name = cbmBinaryName();
  const out: string[] = [];
  const cfg = ctx.config.platform.graph.binary?.trim();
  if (cfg && isAbsolute(cfg)) {
    out.push(cfg);
  }
  const envBin = env.DEVKIT_CBM_BINARY?.trim();
  if (envBin && isAbsolute(envBin)) {
    out.push(envBin);
  }
  out.push(...mcpCommandPaths(ctx));
  for (const dir of pathDirs(env)) {
    out.push(join(dir, name));
  }
  out.push(join(homeOf(env), ".local", "bin", name));
  out.push(join(ctx.paths.binDir, name));
  return out;
}

async function binaryMeetsMin(
  path: string,
  env: EnvMap,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<boolean> {
  if (!isExecutableFile(path)) {
    return false;
  }
  const result = await runCbm(path, ["--version"], {
    timeoutMs: opts.timeoutMs,
    env,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (result.timedOut) {
    return false;
  }
  const parts = parseVersionParts(`${result.stdout}\n${result.stderr}`);
  if (!parts) {
    return false;
  }
  return versionGte(parts, CBM_MIN_VERSION_PARTS);
}

export async function discoverCbmBinary(
  ctx: PlatformContext,
  opts: CbmDiscoverOpts = {},
): Promise<string | undefined> {
  const seen = new Set<string>();
  const started = Date.now();
  for (const cand of candidateBinaries(ctx)) {
    if (opts.signal?.aborted) {
      return undefined;
    }
    if (!existsSync(cand)) {
      continue;
    }
    const real = tryRealpath(cand);
    if (seen.has(real)) {
      continue;
    }
    seen.add(real);
    let versionTimeout = VERSION_TIMEOUT_MS;
    if (opts.timeoutMs !== undefined) {
      const left = opts.timeoutMs - (Date.now() - started);
      if (left <= 0) {
        return undefined;
      }
      versionTimeout = Math.max(1, left);
    }
    if (
      await binaryMeetsMin(real, ctx.env, {
        timeoutMs: versionTimeout,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    ) {
      return real;
    }
  }
  return undefined;
}

export async function requireCbmBinary(
  ctx: PlatformContext,
  opts: CbmDiscoverOpts = {},
): Promise<string> {
  const found = await discoverCbmBinary(ctx, opts);
  if (opts.signal?.aborted) {
    throw graphTimeout("codebase-memory-mcp discovery timed out");
  }
  if (!found) {
    throw graphUnavailable(
      `codebase-memory-mcp >= ${CBM_MIN_VERSION} is not available`,
      MISSING_HINT,
    );
  }
  return found;
}

function confineRepoPath(ctx: PlatformContext, raw: string): string {
  const abs = resolve(raw);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw graphUnavailable(`Path not found: ${abs}`);
  }
  const root = ctx.repoPath;
  if (real === root) {
    return real;
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!real.startsWith(prefix)) {
    throw graphUnavailable("repo path is outside the worktree");
  }
  return real;
}

function throwIfAdmission(text: string): void {
  if (ADMISSION_RE.test(text)) {
    throw graphUnavailable("CBM admission failed", SAME_BINARY_HINT);
  }
}

function isMcpEnvelopeText(stdout: string): boolean {
  if (!stdout) {
    return false;
  }
  try {
    const env = JSON.parse(stdout) as unknown;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      return false;
    }
    return "isError" in env || "structuredContent" in env || "content" in env;
  } catch {
    return false;
  }
}

export async function cbmCli(
  ctx: PlatformContext,
  tool: string,
  flags: CbmFlags,
  opts: CbmCliOpts,
): Promise<unknown> {
  const started = Date.now();
  const binary =
    opts.binary ??
    (await requireCbmBinary(
      ctx,
      opts.signal ? { timeoutMs: opts.timeoutMs, signal: opts.signal } : {},
    ));
  const nextFlags = { ...flags };
  const repoPath = nextFlags["repo-path"];
  if (typeof repoPath === "string") {
    nextFlags["repo-path"] = confineRepoPath(ctx, repoPath);
  }
  const args = ["cli", "--json", tool, ...encodeCbmFlags(nextFlags)];
  const spawnTimeout = opts.signal
    ? Math.max(1, opts.timeoutMs - (Date.now() - started))
    : opts.timeoutMs;
  const result = await runCbm(binary, args, {
    timeoutMs: spawnTimeout,
    env: ctx.env,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) {
    throwIfAdmission(combined);
    throw graphTimeout(`codebase-memory-mcp ${tool} timed out`);
  }
  const trimmed = result.stdout.trim();
  if (result.status !== 0) {
    throwIfAdmission(combined);
    // v0.10.8 cli --json still prints the MCP envelope and exits 1 when isError.
    if (isMcpEnvelopeText(trimmed)) {
      unwrapCbmJson(trimmed);
    }
    const detail = (result.stderr.trim() || trimmed).slice(0, 500);
    throw graphUnavailable(`codebase-memory-mcp ${tool} failed`, detail || undefined);
  }
  try {
    return unwrapCbmJson(trimmed);
  } catch (err) {
    throwIfAdmission(combined);
    throw err;
  }
}

export function missingCbmInitError(): PlatformError {
  return graphUnavailable(
    `No codebase-memory-mcp >= ${CBM_MIN_VERSION}. Run 'devkit init' in a terminal and type y to download the pinned v${CBM_MIN_VERSION} binary into DEVKIT_HOME/bin.`,
  );
}
