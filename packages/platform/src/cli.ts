#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext } from "./lib/context.js";
import { errorMessage, exitCodeFor, isPlatformError, PlatformError } from "./lib/errors.js";

export type CliArgs = {
  help: boolean;
  path?: string;
  config?: string;
  verification?: string;
  command?: string;
  rest: string[];
};

const KNOWN_COMMANDS = new Set(["init", "playbook", "tune", "mcp", "hook"]);

const HELP = `Usage: devkit [options] <command>

Options:
  --help                  Show help
  --path <dir>            Repository path (default: current directory)
  --config <file>         Extra config file
  --verification <level>  off | light | full

Commands:
  init       Prepare the local graph index
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
  const out: CliArgs = { help: false, rest: [] };
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
};

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

  if (!args.command) {
    io.stdout.write(HELP);
    return 0;
  }

  try {
    await createContext({
      repoPath: args.path,
      configFile: args.config,
      verification: args.verification,
      env,
    });
  } catch (err) {
    return writeError(io, err);
  }

  if (KNOWN_COMMANDS.has(args.command)) {
    io.stderr.write(`devkit: ${args.command} is not implemented\n`);
    return 1;
  }

  io.stderr.write(`devkit: unknown command '${args.command}'\n`);
  io.stdout.write(HELP);
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
