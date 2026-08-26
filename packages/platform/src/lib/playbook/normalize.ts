import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ObserveEvent, PurposeTag } from "./types.js";

export type Normalized = {
  argv: string[];
  command: string;
  key: string;
  purpose_tags: PurposeTag[];
  cwd_rel: string | null;
};

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

export function commandBase(token: string | undefined): string {
  if (!token) {
    return "";
  }
  let b = basename(token);
  b = b.replace(/\.(exe|cmd|bat)$/i, "");
  return b.toLowerCase();
}

function stripSep(p: string): string {
  return p.replace(/[\\/]+$/g, "");
}

function posixSlashes(token: string): string {
  return token.split("\\").join("/");
}

function replacePathPrefix(token: string, prefix: string, rep: string): string {
  const p = stripSep(prefix);
  if (!p) {
    return token;
  }
  if (token === p) {
    return rep;
  }
  if (token.startsWith(`${p}/`) || token.startsWith(`${p}\\`)) {
    return posixSlashes(`${rep}${token.slice(p.length)}`);
  }
  return token;
}

function homePath(): string {
  const home = homedir();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

export function splitArgv(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) {
      continue;
    }
    if (quote === "'") {
      if (c === "'") {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "\\" && i + 1 < command.length) {
        const next = command[i + 1];
        cur += next ?? "";
        i += 1;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    // On Windows `\` is a path separator, not an escape.
    if (process.platform !== "win32" && c === "\\" && i + 1 < command.length) {
      const next = command[i + 1];
      cur += next ?? "";
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur) {
    out.push(cur);
  }
  return out;
}

function collapseCommand(raw: string): string {
  let s = raw.replace(/\\\r?\n/g, " ");
  s = s.replace(/\\$/g, "");
  return s.replace(/\s+/g, " ").trim();
}

function dropLeadingEnv(argv: string[]): string[] {
  const out = argv.slice();
  while (out.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0] ?? "")) {
    out.shift();
  }
  return out;
}

const LONE_ESCAPE = new Set([
  ".",
  "s",
  "n",
  "t",
  "r",
  "d",
  "w",
  "b",
  "S",
  "N",
  "D",
  "W",
  "B",
  "a",
  "e",
  "f",
  "v",
]);

function hasWinPathSeparator(token: string): boolean {
  for (const m of token.matchAll(/([^\\/]+)\\([^\\/]+)/g)) {
    const after = m[2];
    if (after === undefined) {
      continue;
    }
    if (after.length >= 2) {
      return true;
    }
    if (after.length === 1 && !LONE_ESCAPE.has(after)) {
      return true;
    }
  }
  return false;
}

function isWinPathToken(token: string): boolean {
  if (!token.includes("\\")) {
    return false;
  }
  if (token.startsWith(".\\") || token.startsWith("~\\")) {
    return true;
  }
  if (/^[A-Za-z]:\\/.test(token)) {
    return true;
  }
  if (token.startsWith("\\\\")) {
    return true;
  }
  return hasWinPathSeparator(token);
}

function rewriteToken(token: string, repoPath: string, home: string): string {
  let t = token;
  t = t.split("${HOME}").join("~");
  t = t.split("$HOME").join("~");
  t = replacePathPrefix(t, repoPath, ".");
  t = replacePathPrefix(t, home, "~");
  if (isWinPathToken(t)) {
    return posixSlashes(t);
  }
  return t;
}

export function makeKey(argv: string[]): string {
  if (argv.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const t of argv) {
    if (t.startsWith("-")) {
      break;
    }
    parts.push(t);
    if (parts.length >= 5) {
      break;
    }
  }
  return parts.join(" ").slice(0, 200);
}

export function purposeTags(argv: string[]): PurposeTag[] {
  const tags = new Set<PurposeTag>();
  const a0 = commandBase(argv[0]);
  const a1 = argv[1];
  const a2 = argv[2];
  const pm = a0 === "npm" || a0 === "pnpm" || a0 === "yarn" || a0 === "bun";

  if (
    a0 === "pytest" ||
    a0 === "vitest" ||
    a0 === "jest" ||
    a0 === "ctest" ||
    (a0 === "go" && a1 === "test") ||
    (a0 === "cargo" && a1 === "test") ||
    (pm && a1 === "test") ||
    (pm && a1 === "run" && a2 === "test") ||
    (a0 === "make" && a1 === "test")
  ) {
    tags.add("test");
  }

  if (
    a0 === "tsc" ||
    a0 === "webpack" ||
    a0 === "build" ||
    (a0 === "cargo" && a1 === "build") ||
    (a0 === "go" && a1 === "build") ||
    (a0 === "vite" && a1 === "build") ||
    (pm && a1 === "build") ||
    (pm && a1 === "run" && a2 === "build") ||
    (a0 === "make" && a1 === "build")
  ) {
    tags.add("build");
  }

  if (
    a0 === "eslint" ||
    a0 === "ruff" ||
    a0 === "golangci-lint" ||
    a0 === "lint" ||
    a1 === "lint" ||
    (a0 === "prettier" && argv.includes("--check")) ||
    (pm && a1 === "run" && a2 === "lint")
  ) {
    tags.add("lint");
  }

  if (
    a0 === "migrate" ||
    a0 === "alembic" ||
    a0 === "flyway" ||
    (a0 === "prisma" && a1 === "migrate") ||
    (a0 === "diesel" && a1 === "migration") ||
    a1 === "migrate"
  ) {
    tags.add("migrate");
  }

  if (a0 === "publish" || (pm && a1 === "publish") || (a0 === "cargo" && a1 === "publish")) {
    tags.add("publish");
  }

  if (
    ((a0 === "docker" || a0 === "podman") && a1 === "compose") ||
    (pm && a1 === "start") ||
    (a0 === "make" && a1 === "run")
  ) {
    tags.add("run");
  }

  if (tags.size === 0) {
    return ["other"];
  }
  return [...tags];
}

export function cwdRel(repoPath: string, cwd: string): string | null {
  let abs: string;
  try {
    abs = realpathSync(resolve(cwd));
  } catch {
    abs = resolve(cwd);
  }
  const rel = relative(repoPath, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  if (rel === "") {
    return ".";
  }
  return rel.split("\\").join("/");
}

function toRelPath(repoPath: string, raw: string): string {
  const first = (raw.split(/\r?\n/)[0] ?? "").trim().slice(0, 400);
  if (!first) {
    return ".";
  }
  const abs = isAbsolute(first) ? first : resolve(repoPath, first);
  const rel = relative(repoPath, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return first;
  }
  if (rel === "") {
    return ".";
  }
  return rel.split("\\").join("/");
}

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export function normalizeCommand(raw: string, repoPath: string, cwd: string): Normalized {
  const collapsed = collapseCommand(raw);
  const home = homePath();
  const argv = dropLeadingEnv(splitArgv(collapsed))
    .map((t) => rewriteToken(t, repoPath, home))
    .filter((t) => t.length > 0);
  return {
    argv,
    command: argv.join(" "),
    key: makeKey(argv),
    purpose_tags: purposeTags(argv),
    cwd_rel: cwdRel(repoPath, cwd),
  };
}

export function normalizeWrite(
  toolName: string,
  raw: string,
  repoPath: string,
  cwd: string,
): Normalized {
  const rel = toRelPath(repoPath, raw);
  const tool = `tool:${toolName}`;
  const argv = [tool, `path=${rel}`];
  return {
    argv,
    command: `${tool} path=${rel}`,
    key: makeKey(argv),
    purpose_tags: ["other"],
    cwd_rel: cwdRel(repoPath, cwd),
  };
}

export function normalizeObserve(ev: ObserveEvent, repoPath: string): Normalized | null {
  if (isWriteTool(ev.tool_name)) {
    return normalizeWrite(ev.tool_name, ev.raw_command ?? "", repoPath, ev.cwd);
  }
  const raw = ev.raw_command?.trim();
  if (!raw) {
    return null;
  }
  const norm = normalizeCommand(raw, repoPath, ev.cwd);
  if (norm.argv.length === 0) {
    return null;
  }
  return norm;
}

export function pathExistsInRepo(repoPath: string, token: string): boolean {
  if (!token || token === "." || token === "..") {
    return false;
  }
  const abs = isAbsolute(token) ? token : resolve(repoPath, token);
  try {
    if (!existsSync(abs)) {
      return false;
    }
    let realRepo = repoPath;
    try {
      realRepo = realpathSync(repoPath);
    } catch {
      // keep repoPath
    }
    let realAbs = abs;
    try {
      realAbs = realpathSync(abs);
    } catch {
      // keep abs
    }
    const rel = relative(realRepo, realAbs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
