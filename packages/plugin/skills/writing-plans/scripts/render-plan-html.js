#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const PLATFORM_MISSING =
  "devkit: platform is missing. Install @coredevkit/platform and run `devkit init`.";

function planDirFromArgv(argv) {
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
  return { dir: process.cwd() };
}

const parsed = planDirFromArgv(process.argv.slice(2));
if (parsed.error) {
  process.stderr.write(`devkit: ${parsed.error}\n`);
  process.exit(1);
}

const child = spawn(
  "devkit",
  ["plan", "--render", "--plan", resolve(parsed.dir ?? process.cwd())],
  { stdio: "inherit", shell: false },
);
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
