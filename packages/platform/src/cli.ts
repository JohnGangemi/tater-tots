#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type IndexMode } from "./lib/config.js";
import { createContext } from "./lib/context.js";
import { errorMessage, exitCodeFor, isPlatformError, PlatformError } from "./lib/errors.js";
import { formatInitStdout, initGraph } from "./lib/graph/init.js";
import type { HttpsGet } from "./lib/graph/cbm-fetch.js";

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

  try {
    const ctx = await createContext({
      repoPath: args.path,
      configFile: args.config,
      verification: args.verification,
      env,
    });
    if (args.command === "init") {
      const mode = parseInitMode(args.mode);
      const waitTimeoutSec = parseWaitTimeout(args.waitTimeoutSec);
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
    }
  } catch (err) {
    return writeError(io, err);
  }

  io.stderr.write(`devkit: ${args.command} is not implemented\n`);
  return 1;
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
