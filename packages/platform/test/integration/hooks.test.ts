import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo } from "../../src/cli.js";
import { SESSION_START_BUDGET_MS } from "../../src/hook.js";
import { createContext } from "../../src/lib/context.js";
import { evidenceSpawnCalls } from "../../src/lib/evidence/check.js";
import { cbmBinaryName } from "../../src/lib/graph/cbm-release.js";
import { playbookRecord } from "../../src/lib/playbook/store.js";

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
  const dir = tmp("devkit-hook-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function basePath(): string {
  return [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
}

function isolatedEnv(dataRoot: string, extra: { pathPrefix?: string[] } = {}): NodeJS.ProcessEnv {
  const home = tmp("devkit-hook-home-");
  const pathParts = [...(extra.pathPrefix ?? []), basePath()];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-hook-xdg-"),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: pathParts.join(delimiter),
    PATHEXT: process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM",
  };
  delete env.DEVKIT_CBM_BINARY;
  delete env.DEVKIT_LOG_STDERR;
  delete env.DEVKIT_PLAYBOOK_RESET;
  delete env.DEVKIT_VERIFICATION;
  return env;
}

function captureIo(stdin: string): { io: CliIo; out: () => string; err: () => string } {
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
      stdin: Readable.from([stdin]),
    },
    out: () => out,
    err: () => err,
  };
}

async function runHook(
  kind: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  extra: { path: string; config?: string },
): Promise<{ code: number; out: string; err: string }> {
  const argv = ["node", "devkit", "--path", extra.path];
  if (extra.config) {
    argv.push("--config", extra.config);
  }
  argv.push("hook", kind);
  const cap = captureIo(JSON.stringify(payload));
  const code = await runCli(argv, env, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

function sessionStartPayload(cwd: string): Record<string, unknown> {
  return {
    cwd,
    hook_event_name: "SessionStart",
    session_id: "sess-1",
    source: "startup",
  };
}

function postToolPayload(
  cwd: string,
  extra: { command?: string; toolName?: string; exitCode?: number } = {},
): Record<string, unknown> {
  return {
    cwd,
    hook_event_name: "PostToolUse",
    session_id: "sess-1",
    tool_name: extra.toolName ?? "Bash",
    tool_input: { command: extra.command ?? "npm test" },
    tool_response: { stdout: "ok", exitCode: extra.exitCode ?? 0 },
    duration_ms: 12,
  };
}

function stopPayload(
  cwd: string,
  extra: { text?: string; skill?: string; stopHookActive?: boolean } = {},
): Record<string, unknown> {
  return {
    cwd,
    hook_event_name: "Stop",
    session_id: "sess-1",
    last_assistant_message: extra.text ?? "still writing tests",
    ...(extra.skill ? { skill_name: extra.skill, loaded_skills: [extra.skill] } : {}),
    ...(extra.stopHookActive ? { stop_hook_active: true } : {}),
  };
}

function parseJson(out: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(out.trim());
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  return parsed as Record<string, unknown>;
}

function additionalContext(out: string): string {
  const parsed = parseJson(out);
  const spec = parsed.hookSpecificOutput;
  assert.equal(typeof spec, "object");
  assert.notEqual(spec, null);
  const text = (spec as { additionalContext?: unknown }).additionalContext;
  assert.equal(typeof text, "string");
  return text as string;
}

function writeSlowCbm(dir: string, delayMs: number): string {
  const name = cbmBinaryName();
  const path = join(dir, name);
  const body = `#!/usr/bin/env node
if (process.argv.includes("--version") || process.argv[2] === "-V") {
  process.stdout.write("codebase-memory-mcp 0.10.8\\n");
  process.exit(0);
}
setTimeout(() => {}, ${delayMs});
`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function writeFailingNpm(dir: string, mark: string): void {
  const js = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(mark)}, "spawned");
process.exit(1);
`;
  if (process.platform === "win32") {
    const script = join(dir, "npm.js");
    writeFileSync(script, js);
    writeFileSync(join(dir, "npm.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return;
  }
  writeFileSync(join(dir, "npm"), `#!${process.execPath}\n${js}\n`);
  chmodSync(join(dir, "npm"), 0o755);
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-IN-09 SessionStart stdout additionalContext line count is at most 20", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const result = await runHook("session-start", sessionStartPayload(repo), env, { path: repo });
  assert.equal(result.code, 0);
  const pointer = additionalContext(result.out);
  const lines = pointer.split("\n");
  assert.ok(lines.length > 0);
  assert.ok(lines.length <= 20, `line count ${lines.length}`);
  assert.match(pointer, /^CoreDevKit platform$/m);
  assert.match(pointer, /^graph: /m);
  assert.match(pointer, /^playbook_entries: /m);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(existsSync(ctx.paths.sessionPointerFile), true);
  const pointerJson = JSON.parse(readFileSync(ctx.paths.sessionPointerFile, "utf8")) as {
    model?: unknown;
    repo_id?: unknown;
    skills?: unknown;
  };
  assert.equal("model" in pointerJson, false);
  assert.equal(typeof pointerJson.repo_id, "string");
  assert.ok(Array.isArray(pointerJson.skills));
});

test("T-IN-10 Hook with missing playbook file exits 0", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(existsSync(ctx.paths.playbookFile), false);
  const post = await runHook("post-tool-use", postToolPayload(repo), env, { path: repo });
  assert.equal(post.code, 0);
  assert.equal(post.out.trim(), "");
  assert.equal(post.out.includes("additionalContext"), false);
  const start = await runHook("session-start", sessionStartPayload(repo), env, { path: repo });
  assert.equal(start.code, 0);
  const pointer = additionalContext(start.out);
  assert.ok(pointer.split("\n").length <= 20);
});

test("T-IN-11 Stop skip_skills superpowers does not spawn evidence", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const binDir = tmp("devkit-hook-bin-");
  const mark = join(tmp("devkit-hook-mark-"), "mark.txt");
  writeFailingNpm(binDir, mark);
  const env = isolatedEnv(dataRoot, { pathPrefix: [binDir] });
  const ctx = await createContext({ repoPath: repo, env });
  const stored = await playbookRecord(ctx, {
    raw_command: "npm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 0,
    duration_ms: 12,
  });
  assert.equal(stored.result, "stored");
  const config = join(tmp("devkit-hook-cfg-"), "config.yaml");
  writeFileSync(
    config,
    [
      "platform:",
      "  skip_skills:",
      "    - superpowers",
      "  stop_blocking: true",
      "  evidence_on_stop: true",
      "verification:",
      "  level: light",
      "",
    ].join("\n"),
  );
  evidenceSpawnCalls.length = 0;
  const result = await runHook(
    "stop",
    stopPayload(repo, { text: "tests passed", skill: "superpowers" }),
    env,
    { path: repo, config },
  );
  assert.equal(result.code, 0);
  assert.equal(evidenceSpawnCalls.length, 0);
  assert.equal(existsSync(mark), false);
  assert.equal(result.out.includes("additionalContext"), false);
  assert.equal(result.out.includes('"decision"'), false);
});

test("T-IN-14 Slow fake CBM prints graph unknown within 200 ms", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const binDir = tmp("devkit-hook-slow-");
  const delayMs = 2500;
  writeSlowCbm(binDir, delayMs);
  const env = isolatedEnv(dataRoot, { pathPrefix: [binDir] });
  const started = Date.now();
  const result = await runHook("session-start", sessionStartPayload(repo), env, { path: repo });
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0);
  const pointer = additionalContext(result.out);
  assert.match(pointer, /^graph: unknown$/m);
  assert.ok(
    elapsed < SESSION_START_BUDGET_MS + 800,
    `elapsed ${elapsed}ms exceeds SessionStart budget`,
  );
  assert.ok(elapsed < delayMs, `elapsed ${elapsed}ms waited for slow CBM`);
});

test("T-IN-15 Stop with no claimed-completion text does not spawn", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const binDir = tmp("devkit-hook-bin-");
  const mark = join(tmp("devkit-hook-mark-"), "mark.txt");
  writeFailingNpm(binDir, mark);
  const env = isolatedEnv(dataRoot, { pathPrefix: [binDir] });
  const ctx = await createContext({ repoPath: repo, env });
  await playbookRecord(ctx, {
    raw_command: "npm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 0,
    duration_ms: 12,
  });
  const config = join(tmp("devkit-hook-cfg-"), "config.yaml");
  writeFileSync(
    config,
    ["platform:", "  stop_blocking: true", "  evidence_on_stop: true", ""].join("\n"),
  );
  evidenceSpawnCalls.length = 0;
  const result = await runHook("stop", stopPayload(repo, { text: "still writing tests" }), env, {
    path: repo,
    config,
  });
  assert.equal(result.code, 0);
  assert.equal(result.out, "");
  assert.equal(evidenceSpawnCalls.length, 0);
  assert.equal(existsSync(mark), false);
});

test("T-IN-16 Stop claimed-completion with stop_blocking false does not block", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const binDir = tmp("devkit-hook-bin-");
  const mark = join(tmp("devkit-hook-mark-"), "mark.txt");
  writeFailingNpm(binDir, mark);
  const env = isolatedEnv(dataRoot, { pathPrefix: [binDir] });
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(ctx.config.platform.stop_blocking, false);
  await playbookRecord(ctx, {
    raw_command: "npm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 0,
    duration_ms: 12,
  });
  evidenceSpawnCalls.length = 0;
  const result = await runHook("stop", stopPayload(repo, { text: "that's all" }), env, {
    path: repo,
  });
  assert.equal(result.code, 0);
  assert.equal(result.out.includes("additionalContext"), false);
  assert.equal(result.out.includes('"decision"'), false);
  assert.equal(existsSync(mark), false);
  assert.equal(evidenceSpawnCalls.length, 0);
  if (result.out.trim()) {
    const parsed = parseJson(result.out);
    assert.equal("additionalContext" in parsed, false);
    assert.equal("decision" in parsed, false);
    const spec = parsed.hookSpecificOutput;
    if (spec && typeof spec === "object") {
      assert.equal("additionalContext" in spec, false);
    }
  }
});
