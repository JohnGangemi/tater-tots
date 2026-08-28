import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dirs: string[] = [];
const pluginRoot = fileURLToPath(new URL("../..", import.meta.url));
const distCli = join(pluginRoot, "dist", "cli.js");

const LOGICAL_TOOL_NAMES = [
  "graph_search",
  "graph_symbol",
  "graph_impact",
  "playbook_lookup",
  "playbook_record",
  "evidence_check",
  "adversarial_review",
  "tune_status",
  "tune_accept",
  "tune_reject",
] as const;

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function makeRepo(): string {
  const dir = tmp("devkit-mcp-plugin-repo-");
  git(dir, ["init"]);
  git(dir, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return dir;
}

function isolatedEnv(dataRoot: string): Record<string, string> {
  const home = tmp("devkit-home-");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.DEVKIT_DATA_DIR = dataRoot;
  env.XDG_CONFIG_HOME = tmp("devkit-xdg-");
  env.HOME = home;
  env.USERPROFILE = home;
  env.PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  delete env.DEVKIT_CONFIG;
  delete env.DEVKIT_PLAN;
  delete env.DEVKIT_VERIFICATION;
  delete env.DEVKIT_PATH;
  delete env.DEVKIT_LOG_STDERR;
  return env;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-IN-P-09 plugin CLI mcp still lists the 10 logical names", async () => {
  assert.equal(LOGICAL_TOOL_NAMES.length, 10);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distCli, "--path", repo, "mcp"],
    cwd: tmp("devkit-mcp-cwd-"),
    env,
    stderr: "pipe",
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(String(chunk));
  });
  const client = new Client({
    name: "devkit-plugin-mcp-test",
    version: "0.0.0",
  });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, "coredevkit");
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...LOGICAL_TOOL_NAMES].sort());
    assert.equal(listed.tools.length, 10);
    assert.equal(
      listed.tools.some(
        (t) => t.name.startsWith("plan") || t.name.includes("implement"),
      ),
      false,
    );
  } finally {
    await client.close();
  }
  assert.equal(stderrChunks.join(""), "");
});
