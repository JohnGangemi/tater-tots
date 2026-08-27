import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type CliIo } from "../../src/cli.js";
import { createContext } from "../../src/lib/context.js";
import {
  evidenceCheck,
  evidenceSpawnCalls,
  type EvidenceResult,
} from "../../src/lib/evidence/check.js";
import { playbookRecord } from "../../src/lib/playbook/store.js";
import { createMcpServer } from "../../src/mcp.js";

const dirs: string[] = [];

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
  const dir = tmp("devkit-ev-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function writePosixExec(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function writeWinCmd(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.cmd`);
  writeFileSync(path, body);
  return path;
}

function writeRecorder(dir: string, name: string, extraJs: string): string {
  const js = `
const fs = require("node:fs");
const mark = process.env.EVIDENCE_SPAWN_MARK;
if (mark) fs.writeFileSync(mark, "spawned");
const log = process.env.EVIDENCE_SPAWN_LOG;
if (log) {
  fs.writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), script: process.argv[1] }));
}
${extraJs}
`;
  if (process.platform === "win32") {
    const script = join(dir, `${name}.js`);
    writeFileSync(script, js);
    return writeWinCmd(dir, name, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  return writePosixExec(dir, name, js);
}

function isolatedEnv(
  dataRoot: string,
  binDir: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const home = tmp("devkit-ev-home-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-ev-xdg-"),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: [binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    PATHEXT: process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM",
    ...extra,
  };
  delete env.DEVKIT_CBM_BINARY;
  delete env.DEVKIT_LOG_STDERR;
  delete env.DEVKIT_PLAYBOOK_RESET;
  delete env.DEVKIT_VERIFICATION;
  return env;
}

function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: {
        write: (s: string) => {
          out += String(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
      stderr: {
        write: (s: string) => {
          err += String(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    },
    out: () => out,
    err: () => err,
  };
}

function makeBins(): { binDir: string; mark: string; log: string } {
  const binDir = tmp("devkit-ev-bin-");
  const mark = join(tmp("devkit-ev-mark-"), "mark.txt");
  const log = join(tmp("devkit-ev-log-"), "spawn.json");
  const retryJs = `
const stamp = process.env.EVIDENCE_RETRY_STAMP;
if (stamp) {
  if (!fs.existsSync(stamp)) {
    fs.writeFileSync(stamp, "1");
    process.exit(1);
  }
  process.exit(0);
}
process.stdout.write("ok-tail\\n");
process.exit(0);
`;
  const failJs = `
process.stdout.write("fail-tail\\n");
process.exit(1);
`;
  writeRecorder(binDir, "true", `process.stdout.write("ok-tail\\n"); process.exit(0);`);
  writeRecorder(binDir, "false", failJs);
  writeRecorder(binDir, "rm", `process.exit(0);`);
  writeRecorder(binDir, "npm", retryJs);
  return { binDir, mark, log };
}

function parseResult(text: string): EvidenceResult {
  return JSON.parse(text) as EvidenceResult;
}

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

function isCallToolResult(
  result: ToolCallResult,
): result is Extract<ToolCallResult, { content: unknown[] }> {
  return "content" in result;
}

function toolPayload(result: ToolCallResult): Record<string, unknown> {
  assert.equal(isCallToolResult(result), true);
  if (!isCallToolResult(result)) {
    throw new Error("expected tool result");
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const block = result.content.find((item) => item.type === "text");
  assert.equal(block?.type, "text");
  if (block?.type !== "text") {
    throw new Error("expected text content");
  }
  const parsed: unknown = JSON.parse(block.text);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  return parsed as Record<string, unknown>;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-EV-01 rm -rf // is denied and the child is not spawned", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir, mark } = makeBins();
  const env = isolatedEnv(dataRoot, binDir, { EVIDENCE_SPAWN_MARK: mark });
  const ctx = await createContext({ repoPath: repo, env });
  const result = await evidenceCheck(ctx, { command: "rm -rf //" });
  assert.equal(result.verdict, "denied");
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 0);
  assert.equal(evidenceSpawnCalls.length, 0);
  assert.equal(existsSync(mark), false);
});

test(
  "T-EV-02 POSIX: playbook argv five args, shell false, no /bin/sh",
  { skip: process.platform === "win32" },
  async () => {
    const dataRoot = tmp("devkit-data-");
    const repo = makeRepo();
    const { binDir, log } = makeBins();
    const env = isolatedEnv(dataRoot, binDir, { EVIDENCE_SPAWN_LOG: log });
    const ctx = await createContext({ repoPath: repo, env });
    const stored = await playbookRecord(ctx, {
      raw_command: "npm test -- --run x",
      tool_name: "Bash",
      cwd: repo,
      exit_code: 0,
      duration_ms: 10,
    });
    assert.equal(stored.result, "stored");
    const result = await evidenceCheck(ctx, { purpose: "test" });
    assert.equal(result.verdict, "pass");
    assert.equal(evidenceSpawnCalls.length, 1);
    const call = evidenceSpawnCalls[0];
    assert.ok(call);
    assert.equal(call.shell, false);
    assert.equal(basename(call.file), "npm");
    assert.deepEqual(call.args, ["test", "--", "--run", "x"]);
    assert.equal(call.file.includes("/bin/sh"), false);
    const logged = JSON.parse(readFileSync(log, "utf8")) as { argv: string[] };
    assert.deepEqual(logged.argv, ["test", "--", "--run", "x"]);
  },
);

test(
  "T-EV-03 Windows: argv[0] npm resolves via PATHEXT; shell stays false",
  { skip: process.platform !== "win32" },
  async () => {
    const dataRoot = tmp("devkit-data-");
    const repo = makeRepo();
    const { binDir } = makeBins();
    const env = isolatedEnv(dataRoot, binDir);
    const ctx = await createContext({ repoPath: repo, env });
    const result = await evidenceCheck(ctx, { argv: ["npm", "test", "--", "--run", "x"] });
    assert.equal(result.verdict, "pass");
    assert.equal(evidenceSpawnCalls.length, 1);
    const call = evidenceSpawnCalls[0];
    assert.ok(call);
    assert.equal(call.shell, false);
    assert.match(basename(call.file), /^npm\.cmd$/i);
    assert.deepEqual(call.args, ["test", "--", "--run", "x"]);
  },
);

test("T-IN-04 true passes; false fails CLI gate with exit 2; tail present", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir } = makeBins();
  const env = isolatedEnv(dataRoot, binDir);
  const passCap = captureIo();
  const passCode = await runCli(
    ["node", "devkit", "--path", repo, "evidence-check", "--command", "true"],
    env,
    passCap.io,
  );
  assert.equal(passCode, 0);
  const pass = parseResult(passCap.out());
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.ok, true);
  assert.equal(typeof pass.tail, "string");
  assert.match(pass.tail, /ok-tail/);

  const failCap = captureIo();
  const failCode = await runCli(
    ["node", "devkit", "--path", repo, "evidence-check", "--command", "false"],
    env,
    failCap.io,
  );
  assert.equal(failCode, 2);
  const fail = parseResult(failCap.out());
  assert.equal(fail.verdict, "fail");
  assert.equal(fail.ok, false);
  assert.equal(typeof fail.tail, "string");
  assert.match(fail.tail, /fail-tail/);
});

test("T-IN-05 purpose with only fail keys is no_command unless force", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir } = makeBins();
  const env = isolatedEnv(dataRoot, binDir);
  const ctx = await createContext({ repoPath: repo, env });
  const stored = await playbookRecord(ctx, {
    raw_command: "npm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 1,
    duration_ms: 10,
  });
  assert.equal(stored.result, "stored");

  const blocked = await evidenceCheck(ctx, { purpose: "test" });
  assert.equal(blocked.verdict, "no_command");
  assert.equal(blocked.ok, false);
  assert.equal(evidenceSpawnCalls.length, 0);

  const cliCap = captureIo();
  const cliCode = await runCli(
    ["node", "devkit", "--path", repo, "evidence-check", "--purpose", "test"],
    env,
    cliCap.io,
  );
  assert.equal(cliCode, 2);
  assert.equal(parseResult(cliCap.out()).verdict, "no_command");

  const forced = await evidenceCheck(ctx, { purpose: "test", force: true });
  assert.equal(forced.verdict, "pass");
  assert.equal(forced.ok, true);
  assert.ok(forced.attempts >= 1);

  const forceCap = captureIo();
  const forceCode = await runCli(
    ["node", "devkit", "--path", repo, "evidence-check", "--purpose", "test", "--force"],
    env,
    forceCap.io,
  );
  assert.equal(forceCode, 0);
  assert.equal(parseResult(forceCap.out()).verdict, "pass");
});

test("T-IN-06 first fail then pass with evidence_retries 1 yields attempts 2", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir } = makeBins();
  const stamp = join(tmp("devkit-ev-stamp-"), "stamp");
  const env = isolatedEnv(dataRoot, binDir, { EVIDENCE_RETRY_STAMP: stamp });
  const cfg = join(tmp("devkit-ev-cfg-"), "config.yaml");
  writeFileSync(cfg, "verification:\n  evidence_retries: 1\n");
  const ctx = await createContext({ repoPath: repo, env, configFile: cfg });
  const result = await evidenceCheck(ctx, { command: "npm test" });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "pass");
  assert.equal(result.attempts, 2);
  assert.equal(evidenceSpawnCalls.length, 2);
  assert.equal(
    evidenceSpawnCalls.every((c) => c.shell === false),
    true,
  );
});

test("resolved_level off skips with ok true", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir, mark } = makeBins();
  const env = isolatedEnv(dataRoot, binDir, { EVIDENCE_SPAWN_MARK: mark });
  const ctx = await createContext({ repoPath: repo, env, verification: "off" });
  const result = await evidenceCheck(ctx, { command: "true" });
  assert.equal(result.verdict, "skipped");
  assert.equal(result.ok, true);
  assert.equal(result.resolved_level, "off");
  assert.equal(result.attempts, 0);
  assert.equal(evidenceSpawnCalls.length, 0);
  assert.equal(existsSync(mark), false);
});

test("cwd outside the repo is error and does not spawn", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir, mark } = makeBins();
  const env = isolatedEnv(dataRoot, binDir, { EVIDENCE_SPAWN_MARK: mark });
  const ctx = await createContext({ repoPath: repo, env });
  const result = await evidenceCheck(ctx, { command: "true", cwd: tmpdir() });
  assert.equal(result.verdict, "error");
  assert.equal(result.ok, false);
  assert.equal(evidenceSpawnCalls.length, 0);
  assert.equal(existsSync(mark), false);
});

test("CLI denied command exits 2 without spawn", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir, mark } = makeBins();
  const env = isolatedEnv(dataRoot, binDir, { EVIDENCE_SPAWN_MARK: mark });
  const cap = captureIo();
  const code = await runCli(
    ["node", "devkit", "--path", repo, "evidence-check", "--command", "rm -rf //"],
    env,
    cap.io,
  );
  assert.equal(code, 2);
  assert.equal(parseResult(cap.out()).verdict, "denied");
  assert.equal(existsSync(mark), false);
});

test("MCP evidence_check runs a local command and does not set process exit 2", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir } = makeBins();
  const env = isolatedEnv(dataRoot, binDir);
  const server = createMcpServer({ cwd: repo, env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devkit-ev-mcp", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((t) => t.name === "evidence_check"),
      true,
    );
    const called = await client.callTool({
      name: "evidence_check",
      arguments: { command: "false" },
    });
    assert.equal(isCallToolResult(called) && Boolean(called.isError), false);
    const body = toolPayload(called);
    assert.equal(body.verdict, "fail");
    assert.equal(body.ok, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("invalid evidence-check flags do not write user data", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const { binDir } = makeBins();
  const env = isolatedEnv(dataRoot, binDir);
  const cap = captureIo();
  const code = await runCli(
    ["node", "devkit", "--path", repo, "evidence-check", "--bogus"],
    env,
    cap.io,
  );
  assert.equal(code, 1);
  assert.equal(existsSync(join(dataRoot, "devkit", "playbooks")), false);
});
