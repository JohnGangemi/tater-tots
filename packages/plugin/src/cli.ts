#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  errorMessage,
  isPluginError,
  PluginError,
  pluginExitCode,
} from "./lib/errors.js";
import {
  loadPlatform,
  type PlatformImporter,
  type PlatformModule,
} from "./lib/platform-guard.js";
import { loadSkillBody } from "./lib/skill-runner.js";

export const PLUGIN_COMMANDS = new Set([
  "plan",
  "implement",
  "stack",
  "debug",
  "review",
  "finish",
  "issue-to-pr",
  "skill",
]);

const PLUGIN_VALUE_FLAGS = new Set([
  "--plan",
  "--goal",
  "--slug",
  "--mark",
  "--step",
  "--evidence-command",
  "--evidence-purpose",
  "--query",
  "--scope",
  "--issue",
]);

const PLUGIN_BOOL_FLAGS = new Set([
  "--render",
  "--start-coordinator",
  "--replace",
  "--force-evidence",
  "--accept-patch",
  "--skip-remaining",
  "--accept-plan",
  "--publish",
]);

const PLATFORM_VALUE_FLAGS = new Set([
  "--path",
  "--config",
  "--verification",
  "--mode",
  "--wait-timeout-sec",
]);

export const HELP = `Usage: devkit [options] <command>

Options:
  --help                  Show help
  --path <dir>            Repository path (default: current directory)
  --config <file>         Extra config file
  --verification <level>  off | light | full
  --plan <dir>            Plan directory (default: user-data)
  --mode <mode>           init index mode: fast | moderate | full
  --wait-timeout-sec <n>  init wait timeout
  --fetch-cbm             Fetch the graph binary during init

Commands:
  plan       Write dual plan output (plugin)
  implement  Resume and mark coordinator steps (plugin)
  debug      Graph + playbook packet for a failure (plugin)
  review     Review a branch, diff, or step (plugin)
  finish     Evidence summary and remaining steps (plugin)
  issue-to-pr  Issue to pull request or stack (plugin)
  stack      Stacked GitHub pull requests (plugin)
  skill      Show shipped skill body plus personal override
  init [--mode fast|moderate|full] [--wait-timeout-sec N] [--fetch-cbm]
             Prepare the local graph index
  playbook   Show the command playbook
  tune       Show or apply skill overrides
  mcp        Run the MCP server
  hook       Run a harness hook
  evidence-check  Run a platform evidence gate

This help text does not print playbook data.
`;

export type PluginCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  stdinIsTTY?: boolean;
};

export type PluginArgv = {
  help: boolean;
  pluginCommand?: string;
  platformCommand?: string;
  pluginRest: string[];
  plan?: string;
  goal?: string;
  slug?: string;
  render: boolean;
  startCoordinator: boolean;
  replace: boolean;
  remaining: string[];
};

export type RunPluginCliOpts = {
  loadPlatform?: PlatformImporter;
  shippedSkillsDir?: string;
};

function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function takeValue(
  args: string[],
  i: number,
  flag: string,
): { value: string; next: number } {
  const cur = args[i];
  if (cur && cur.startsWith(`${flag}=`)) {
    const value = cur.slice(flag.length + 1);
    if (!value) {
      throw new PluginError("usage", `Flag ${flag} needs a value`);
    }
    return { value, next: i };
  }
  const value = args[i + 1];
  if (!value || value.startsWith("-")) {
    throw new PluginError("usage", `Flag ${flag} needs a value`);
  }
  return { value, next: i + 1 };
}

function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

export function parsePluginArgv(argv: string[]): PluginArgv {
  const remaining: string[] = argv.slice(0, 2);
  const pluginRest: string[] = [];
  const out: PluginArgv = {
    help: false,
    pluginRest,
    remaining,
    render: false,
    startCoordinator: false,
    replace: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) {
      continue;
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      remaining.push(a);
      continue;
    }
    const name = flagName(a);
    if (name === "--plan") {
      const { value, next } = takeValue(args, i, "--plan");
      out.plan = value;
      i = next;
      continue;
    }
    if (PLUGIN_VALUE_FLAGS.has(name)) {
      const { value, next } = takeValue(args, i, name);
      if (name === "--goal") {
        out.goal = value;
      }
      if (name === "--slug") {
        out.slug = value;
      }
      i = next;
      continue;
    }
    if (PLUGIN_BOOL_FLAGS.has(a)) {
      if (a === "--render") {
        out.render = true;
      }
      if (a === "--start-coordinator") {
        out.startCoordinator = true;
      }
      if (a === "--replace") {
        out.replace = true;
      }
      continue;
    }
    if (PLATFORM_VALUE_FLAGS.has(name)) {
      const { value, next } = takeValue(args, i, name);
      if (a.startsWith(`${name}=`)) {
        remaining.push(a);
      } else {
        remaining.push(name);
        remaining.push(value);
      }
      i = next;
      continue;
    }
    if (a === "--fetch-cbm") {
      remaining.push(a);
      continue;
    }
    if (a.startsWith("-")) {
      if (out.pluginCommand) {
        pluginRest.push(a);
      } else {
        remaining.push(a);
      }
      continue;
    }
    if (!out.pluginCommand && PLUGIN_COMMANDS.has(a)) {
      out.pluginCommand = a;
      continue;
    }
    if (out.pluginCommand) {
      pluginRest.push(a);
      continue;
    }
    remaining.push(a);
    if (!out.platformCommand) {
      out.platformCommand = a;
    }
  }
  return out;
}

function writeErr(
  io: PluginCliIo,
  err: unknown,
  platform?: PlatformModule,
): number {
  if (isPluginError(err)) {
    io.stderr.write(`devkit: ${err.message}\n`);
    if (err.hint) {
      io.stderr.write(`${err.hint}\n`);
    }
    return pluginExitCode(err);
  }
  if (platform?.isPlatformError(err)) {
    io.stderr.write(`devkit: ${err.message}\n`);
    if (err.hint) {
      io.stderr.write(`${err.hint}\n`);
    }
    return platform.exitCodeFor(err);
  }
  io.stderr.write(`devkit: ${errorMessage(err)}\n`);
  return 3;
}

async function runSkillShow(
  parsed: PluginArgv,
  env: NodeJS.ProcessEnv,
  io: PluginCliIo,
  platform: PlatformModule,
  shippedSkillsDir: string,
): Promise<number> {
  const sub = parsed.pluginRest[0];
  const name = parsed.pluginRest[1];
  if (sub !== "show" || !name) {
    throw new PluginError("usage", "usage: devkit skill show <name>");
  }
  const args = platform.parseArgv(parsed.remaining);
  const ctx = await platform.createContext({
    repoPath: args.path,
    configFile: args.config,
    verification: args.verification,
    env,
  });
  const body = loadSkillBody(ctx, name, shippedSkillsDir);
  io.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  return 0;
}

export async function runPluginCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: PluginCliIo = process,
  opts: RunPluginCliOpts = {},
): Promise<number> {
  let parsed: PluginArgv;
  try {
    parsed = parsePluginArgv(argv);
  } catch (err) {
    return writeErr(io, err);
  }

  if (
    parsed.help &&
    (!parsed.pluginCommand || parsed.pluginCommand === "plan") &&
    !parsed.platformCommand
  ) {
    io.stdout.write(HELP);
    return 0;
  }
  if (!parsed.pluginCommand && !parsed.platformCommand) {
    io.stdout.write(HELP);
    return 0;
  }

  const loader = opts.loadPlatform ?? loadPlatform;
  let platform: PlatformModule;
  try {
    platform = await loader();
  } catch (err) {
    return writeErr(io, err);
  }

  if (parsed.pluginCommand === "skill") {
    try {
      const shipped = opts.shippedSkillsDir ?? join(pluginRoot(), "skills");
      return await runSkillShow(parsed, env, io, platform, shipped);
    } catch (err) {
      return writeErr(io, err, platform);
    }
  }

  if (parsed.pluginCommand === "plan") {
    try {
      const { runPlanCommand } = await import("./lib/plan/command.js");
      return await runPlanCommand(
        platform,
        {
          remaining: parsed.remaining,
          plan: parsed.plan,
          goal: parsed.goal,
          slug: parsed.slug,
          render: parsed.render,
          startCoordinator: parsed.startCoordinator,
          replace: parsed.replace,
        },
        env,
        io,
      );
    } catch (err) {
      return writeErr(io, err, platform);
    }
  }

  if (parsed.pluginCommand) {
    io.stderr.write(`devkit: ${parsed.pluginCommand} is not implemented\n`);
    return 1;
  }

  return platform.runCli(parsed.remaining, env, io);
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
  runPluginCli(process.argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`devkit: ${errorMessage(err)}\n`);
      process.exit(3);
    });
}
