#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLATFORM_MISSING =
  "devkit: platform is missing. Install @coredevkit/platform and run `devkit init`.";

export function planDirFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        return { error: "Flag --plan needs a value" };
      }
      return { dir: value };
    }
    if (a.startsWith("--plan=")) {
      const value = a.slice("--plan=".length);
      if (!value) {
        return { error: "Flag --plan needs a value" };
      }
      return { dir: value };
    }
  }
  const first = argv[0];
  if (first && !first.startsWith("-")) {
    return { dir: first };
  }
  return {};
}

export function renderSpawnArgs(argv) {
  const parsed = planDirFromArgv(argv);
  if (parsed.error) {
    return parsed;
  }
  const args = ["plan", "--render"];
  if (parsed.dir) {
    args.push("--plan", resolve(parsed.dir));
  }
  return { args };
}

function run(argv) {
  const parsed = renderSpawnArgs(argv);
  if (parsed.error) {
    process.stderr.write(`devkit: ${parsed.error}\n`);
    process.exit(1);
  }
  const child = spawn("devkit", parsed.args ?? ["plan", "--render"], {
    stdio: "inherit",
    shell: false,
  });
  child.on("error", (err) => {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "ENOENT") {
      process.stderr.write(`${PLATFORM_MISSING}\n`);
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : "spawn failed";
    process.stderr.write(`devkit: ${message}\n`);
    process.exit(3);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

function startedFromCli() {
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
  run(process.argv.slice(2));
}
