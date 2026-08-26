import type { PlaybookFilter } from "../config.js";
import { commandBase, pathExistsInRepo } from "./normalize.js";

const INSPECT = new Set([
  "ls",
  "dir",
  "pwd",
  "cd",
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "which",
  "where",
  "type",
  "true",
  "false",
  "clear",
  "history",
  "date",
  "whoami",
  "id",
  "uname",
  "hostname",
  "env",
  "printenv",
  "alias",
  "sleep",
  "man",
]);

const NAMED_EXCLUDE = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebSearch",
  "WebFetch",
]);

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

const GIT_INSPECT_SUB = new Set(["status", "diff", "log", "show", "rev-parse"]);

const GIT_WRITE_SUB = new Set([
  "commit",
  "merge",
  "rebase",
  "push",
  "pull",
  "checkout",
  "switch",
  "stash",
  "reset",
  "clean",
  "tag",
]);

const STATE_CMDS = new Set(["rm", "mv", "cp", "mkdir", "touch", "chmod"]);

const BRANCH_MUTATE = new Set(["-d", "-D", "-m", "-M", "-c", "--delete", "--move", "--copy"]);

const HELP_ONLY = new Set(["--help", "-h", "--version", "-V"]);

const GATE_TAGS = new Set(["test", "build", "lint", "migrate", "publish"]);

function isGitInspect(argv: string[]): boolean {
  if (commandBase(argv[0]) !== "git") {
    return false;
  }
  const sub = argv[1];
  if (sub !== undefined && GIT_INSPECT_SUB.has(sub)) {
    return true;
  }
  if (sub === "branch") {
    return !argv.slice(2).some((t) => BRANCH_MUTATE.has(t));
  }
  if (sub === "remote") {
    return argv.includes("-v") || argv.includes("--verbose");
  }
  if (sub === "config") {
    return argv.includes("--get");
  }
  return false;
}

function isHelpVersionOnly(argv: string[]): boolean {
  return argv.length === 2 && HELP_ONLY.has(argv[1] ?? "");
}

export function isNamedExcludeTool(toolName: string): boolean {
  return NAMED_EXCLUDE.has(toolName);
}

export function isHardExcluded(argv: string[], toolName: string): boolean {
  if (isNamedExcludeTool(toolName)) {
    return true;
  }
  if (INSPECT.has(commandBase(argv[0]))) {
    return true;
  }
  if (isGitInspect(argv)) {
    return true;
  }
  if (isHelpVersionOnly(argv)) {
    return true;
  }
  return false;
}

function isPackageManager(base: string): boolean {
  return base === "npm" || base === "pnpm" || base === "yarn" || base === "bun";
}

function isProjectScript(argv: string[]): boolean {
  const a0 = commandBase(argv[0]);
  const a1 = argv[1];
  if (isPackageManager(a0) && (a1 === "run" || a1 === "start")) {
    return true;
  }
  if (a0 === "make") {
    return a1 !== "help";
  }
  if (a0 === "just") {
    return Boolean(a1) && a1 !== "help";
  }
  return false;
}

function isCompose(argv: string[]): boolean {
  const a0 = commandBase(argv[0]);
  return (a0 === "docker" || a0 === "podman") && argv[1] === "compose";
}

export function isHardIncluded(argv: string[], toolName: string, tags: readonly string[]): boolean {
  if (WRITE_TOOLS.has(toolName)) {
    return true;
  }
  if (isProjectScript(argv) || isCompose(argv)) {
    return true;
  }
  return tags.some((t) => GATE_TAGS.has(t));
}

function hasRedirect(rawCommand: string): boolean {
  if (rawCommand.includes(">>")) {
    return true;
  }
  for (let i = 0; i < rawCommand.length; i++) {
    if (rawCommand[i] !== ">") {
      continue;
    }
    const prev = i > 0 ? rawCommand[i - 1] : "";
    const next = rawCommand[i + 1] ?? "";
    if (prev === ">" || next === ">" || next === "=") {
      continue;
    }
    return true;
  }
  return false;
}

function writesState(argv: string[], rawCommand: string): boolean {
  if (hasRedirect(rawCommand)) {
    return true;
  }
  if (STATE_CMDS.has(commandBase(argv[0]))) {
    return true;
  }
  if (commandBase(argv[0]) === "git") {
    const sub = argv[1];
    if (sub !== undefined && GIT_WRITE_SUB.has(sub)) {
      return true;
    }
  }
  for (const t of argv) {
    if (!t.includes("/") && !t.includes("\\") && STATE_CMDS.has(t)) {
      return true;
    }
  }
  return false;
}

export type SignalInput = {
  argv: string[];
  rawCommand: string;
  durationMs: number | null;
  exitCode: number | null;
  repoPath: string;
  key: string;
  existingKeys: ReadonlySet<string>;
};

export function countSignals(input: SignalInput): number {
  let n = 0;
  if (writesState(input.argv, input.rawCommand)) {
    n += 1;
  }
  if (input.durationMs !== null && input.durationMs > 3000) {
    n += 1;
  }
  if (input.argv.some((t) => pathExistsInRepo(input.repoPath, t))) {
    n += 1;
  }
  if (input.exitCode !== 0) {
    n += 1;
  }
  if (input.existingKeys.has(input.key)) {
    n += 1;
  }
  return n;
}

export function isWorthy(
  filter: PlaybookFilter,
  argv: string[],
  toolName: string,
  tags: readonly string[],
  signals: number,
): boolean {
  if (isHardIncluded(argv, toolName, tags)) {
    return true;
  }
  if (filter === "high") {
    return false;
  }
  const need = filter === "low" ? 1 : 2;
  return signals >= need;
}
