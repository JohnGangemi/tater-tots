#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type IndexMode } from "./lib/config.js";
import { createContext, type PlatformContext } from "./lib/context.js";
import { errorMessage, exitCodeFor, isPlatformError, PlatformError } from "./lib/errors.js";
import type { HttpsGet } from "./lib/graph/cbm-fetch.js";
import { formatInitStdout, initGraph } from "./lib/graph/init.js";
import { runMcpServer } from "./mcp.js";
import { playbookList, playbookStats } from "./lib/playbook/store.js";
import { COMMAND_SHOW_MAX, SHOW_DEFAULT, SHOW_MAX } from "./lib/playbook/types.js";

export type CliArgs = {
  help: boolean;
  path?: string;
  config?: string;
  verification?: string;
  mode?: string;
  waitTimeoutSec?: string;
  fetchCbm: boolean;
  command?: string;
  rest: string[];
};

const KNOWN_COMMANDS = new Set(["init", "playbook", "tune", "mcp", "hook"]);
const INDEX_MODES = new Set<string>(["fast", "moderate", "full"]);

const HELP = `Usage: devkit [options] <command>

Options:
  --help                  Show help
  --path <dir>            Repository path (default: current directory)
  --config <file>         Extra config file
  --verification <level>  off | light | full

Commands:
  init [--mode fast|moderate|full] [--wait-timeout-sec N] [--fetch-cbm]
             Prepare the local graph index
  playbook   Show the command playbook
  tune       Show or apply skill overrides
  mcp        Run the MCP server
  hook       Run a harness hook

This help text does not print playbook data.
`;

function takeValue(args: string[], i: number, flag: string): { value: string; next: number } {
  const cur = args[i];
  if (cur && cur.startsWith(`${flag}=`)) {
    const value = cur.slice(flag.length + 1);
    if (!value) {
      throw new PlatformError("usage", `Flag ${flag} needs a value`);
    }
    return { value, next: i };
  }
  const value = args[i + 1];
  if (!value || value.startsWith("-")) {
    throw new PlatformError("usage", `Flag ${flag} needs a value`);
  }
  return { value, next: i + 1 };
}

export function parseArgv(argv: string[]): CliArgs {
  const out: CliArgs = { help: false, fetchCbm: false, rest: [] };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) {
      continue;
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--path" || a.startsWith("--path=")) {
      const { value, next } = takeValue(args, i, "--path");
      out.path = value;
      i = next;
      continue;
    }
    if (a === "--config" || a.startsWith("--config=")) {
      const { value, next } = takeValue(args, i, "--config");
      out.config = value;
      i = next;
      continue;
    }
    if (a === "--verification" || a.startsWith("--verification=")) {
      const { value, next } = takeValue(args, i, "--verification");
      out.verification = value;
      i = next;
      continue;
    }
    if (a === "--mode" || a.startsWith("--mode=")) {
      const { value, next } = takeValue(args, i, "--mode");
      out.mode = value;
      i = next;
      continue;
    }
    if (a === "--wait-timeout-sec" || a.startsWith("--wait-timeout-sec=")) {
      const { value, next } = takeValue(args, i, "--wait-timeout-sec");
      out.waitTimeoutSec = value;
      i = next;
      continue;
    }
    if (a === "--fetch-cbm") {
      out.fetchCbm = true;
      continue;
    }
    if (a.startsWith("-")) {
      if (out.command) {
        out.rest.push(a);
        continue;
      }
      throw new PlatformError("usage", `Unknown flag ${a}`);
    }
    if (!out.command) {
      out.command = a;
    } else {
      out.rest.push(a);
    }
  }
  return out;
}

export type CliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  stdinIsTTY?: boolean;
  httpsGet?: HttpsGet;
};

function isCliTty(io: CliIo): boolean {
  if (typeof io.stdinIsTTY === "boolean") {
    return io.stdinIsTTY;
  }
  if (io.stdin && "isTTY" in io.stdin) {
    return Boolean((io.stdin as NodeJS.ReadStream).isTTY);
  }
  if (io.stdout === process.stdout) {
    return Boolean(process.stdin.isTTY);
  }
  return false;
}

function parseInitMode(raw: string | undefined): IndexMode | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!INDEX_MODES.has(raw)) {
    throw new PlatformError("usage", `Invalid --mode ${raw} (use fast, moderate, or full)`);
  }
  return raw as IndexMode;
}

function parseWaitTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PlatformError("usage", `Invalid --wait-timeout-sec ${raw}`);
  }
  return n;
}

function writeError(io: CliIo, err: unknown): number {
  if (isPlatformError(err)) {
    io.stderr.write(`devkit: ${err.message}\n`);
    if (err.hint) {
      io.stderr.write(`${err.hint}\n`);
    }
    return exitCodeFor(err);
  }
  io.stderr.write(`devkit: ${errorMessage(err)}\n`);
  return 3;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = process,
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgv(argv);
  } catch (err) {
    return writeError(io, err);
  }

  if (args.help) {
    io.stdout.write(HELP);
    return 0;
  }

  if (args.command && !KNOWN_COMMANDS.has(args.command)) {
    io.stderr.write(`devkit: unknown command '${args.command}'\n`);
    io.stdout.write(HELP);
    return 1;
  }

  if (!args.command) {
    if (args.config || args.verification) {
      try {
        loadConfig({
          repoPath: args.path,
          configFile: args.config,
          verification: args.verification,
          env,
        });
      } catch (err) {
        return writeError(io, err);
      }
    }
    io.stdout.write(HELP);
    return 0;
  }

  if (args.command === "init") {
    try {
      const mode = parseInitMode(args.mode);
      const waitTimeoutSec = parseWaitTimeout(args.waitTimeoutSec);
      const ctx = await createContext({
        repoPath: args.path,
        configFile: args.config,
        verification: args.verification,
        env,
      });
      const result = await initGraph(ctx, {
        ...(mode ? { mode } : {}),
        ...(waitTimeoutSec !== undefined ? { waitTimeoutSec } : {}),
        fetchCbm: args.fetchCbm,
        stdin: io.stdin ?? process.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        stdinIsTTY: isCliTty(io),
        ...(io.httpsGet ? { httpsGet: io.httpsGet } : {}),
      });
      io.stdout.write(formatInitStdout(ctx, result));
      return 0;
    } catch (err) {
      return writeError(io, err);
    }
  }

  if (args.command === "mcp") {
    if (args.rest.length > 0) {
      return writeError(io, new PlatformError("usage", "mcp takes no extra arguments"));
    }
    try {
      await runMcpServer({
        env,
        cwd: args.path ?? process.cwd(),
        ...(args.config ? { configFile: args.config } : {}),
        ...(args.verification ? { verification: args.verification } : {}),
      });
      return 0;
    } catch (err) {
      return writeError(io, err);
    }
  }

  let ctx: PlatformContext;
  try {
    ctx = await createContext({
      repoPath: args.path,
      configFile: args.config,
      verification: args.verification,
      env,
    });
  } catch (err) {
    return writeError(io, err);
  }

  if (args.command === "playbook") {
    try {
      return await runPlaybookCli(ctx, args.rest, io);
    } catch (err) {
      return writeError(io, err);
    }
  }

  io.stderr.write(`devkit: ${args.command} is not implemented\n`);
  return 1;
}

function parseShowLimit(rest: string[]): number {
  let limit = SHOW_DEFAULT;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) {
      continue;
    }
    if (a === "--limit" || a.startsWith("--limit=")) {
      let value = "";
      if (a.startsWith("--limit=")) {
        value = a.slice("--limit=".length);
      } else {
        const next = rest[i + 1];
        if (!next || next.startsWith("-")) {
          throw new PlatformError("usage", "Flag --limit needs a value");
        }
        value = next;
        i += 1;
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        throw new PlatformError("usage", "Flag --limit needs a positive integer");
      }
      limit = Math.min(n, SHOW_MAX);
      continue;
    }
    if (a.startsWith("-")) {
      throw new PlatformError("usage", `Unknown flag ${a}`);
    }
    throw new PlatformError("usage", `Unexpected argument ${a}`);
  }
  return limit;
}

function truncCommand(command: string): string {
  if (command.length <= COMMAND_SHOW_MAX) {
    return command;
  }
  return `${command.slice(0, COMMAND_SHOW_MAX - 3)}...`;
}

async function runPlaybookCli(ctx: PlatformContext, rest: string[], io: CliIo): Promise<number> {
  const sub = rest[0];
  if (sub === "show") {
    const limit = parseShowLimit(rest.slice(1));
    const rows = await playbookList(ctx, limit);
    io.stdout.write("key\tstatus\tcount\tcommand\n");
    for (const row of rows) {
      io.stdout.write(
        `${row.key}\t${row.last_status}\t${row.run_count}\t${truncCommand(row.command)}\n`,
      );
    }
    return 0;
  }
  if (sub === "stats") {
    if (rest.length > 1) {
      throw new PlatformError("usage", "playbook stats takes no extra arguments");
    }
    const stats = await playbookStats(ctx);
    io.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return 0;
  }
  throw new PlatformError("usage", "Unknown playbook command (use show or stats)");
}

function startedFromCli(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(resolve(entry))).href === import.meta.url;
  } catch {
    return false;
  }
}

if (startedFromCli()) {
  runCli(process.argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`devkit: ${errorMessage(err)}\n`);
      process.exit(3);
    });
}
