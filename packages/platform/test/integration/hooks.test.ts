import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

async function runHookRaw(
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; err: string }> {
  const cap = captureIo(stdin);
  const code = await runCli(argv, env, cap.io);
  return { code, out: cap.out(), err: cap.err() };
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
  return runHookRaw(argv, JSON.stringify(payload), env);
}

function sessionStartPayload(
  cwd: string,
  extra: { transcriptPath?: string; sessionId?: string } = {},
): Record<string, unknown> {
  return {
    cwd,
    hook_event_name: "SessionStart",
    session_id: extra.sessionId ?? "sess-1",
    source: extra.transcriptPath ? "resume" : "startup",
    ...(extra.transcriptPath ? { transcript_path: extra.transcriptPath } : {}),
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
  extra: {
    text?: string;
    skill?: string;
    stopHookActive?: boolean;
    transcriptPath?: string;
    omitText?: boolean;
    sessionId?: string;
  } = {},
): Record<string, unknown> {
  return {
    cwd,
    hook_event_name: "Stop",
    session_id: extra.sessionId ?? "sess-1",
    ...(extra.omitText ? {} : { last_assistant_message: extra.text ?? "still writing tests" }),
    ...(extra.transcriptPath ? { transcript_path: extra.transcriptPath } : {}),
    ...(extra.skill ? { skill_name: extra.skill, loaded_skills: [extra.skill] } : {}),
    ...(extra.stopHookActive ? { stop_hook_active: true } : {}),
  };
}

function writeTranscript(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function skillTranscriptRow(skill: string): unknown {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Skill", input: { skill } }],
    },
  };
}

function assistantTextRow(text: string): unknown {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function writeBlockingConfig(extra: string[] = []): string {
  const config = join(tmp("devkit-hook-cfg-"), "config.yaml");
  writeFileSync(
    config,
    [
      "platform:",
      "  stop_blocking: true",
      "  evidence_on_stop: true",
      ...extra,
      "verification:",
      "  level: light",
      "",
    ].join("\n"),
  );
  return config;
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
setTimeout(() => {
  if (process.argv.includes("--version") || process.argv[2] === "-V") {
    process.stdout.write("codebase-memory-mcp 0.10.8\\n");
  }
}, ${delayMs});
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

function writeHungNpm(dir: string): void {
  const js = `setTimeout(() => {}, 30000);\n`;
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
  const transcript = join(tmp("devkit-hook-tr-"), "transcript.jsonl");
  writeTranscript(transcript, [
    skillTranscriptRow("superpowers"),
    assistantTextRow("tests passed"),
  ]);
  const result = await runHook(
    "stop",
    stopPayload(repo, { text: "tests passed", transcriptPath: transcript }),
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

test("Stop stop_hook_active true with claimed text does not spawn", async () => {
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
  const config = writeBlockingConfig();
  evidenceSpawnCalls.length = 0;
  const result = await runHook(
    "stop",
    stopPayload(repo, { text: "that's all", stopHookActive: true }),
    env,
    { path: repo, config },
  );
  assert.equal(result.code, 0);
  assert.equal(result.out, "");
  assert.equal(evidenceSpawnCalls.length, 0);
  assert.equal(existsSync(mark), false);
});

test("Stop claimed-completion from transcript_path JSONL only", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const transcript = join(tmp("devkit-hook-tr-"), "transcript.jsonl");
  writeTranscript(transcript, [assistantTextRow("that's all")]);
  const result = await runHook(
    "stop",
    stopPayload(repo, { omitText: true, transcriptPath: transcript }),
    env,
    { path: repo },
  );
  assert.equal(result.code, 0);
  assert.equal(result.out.includes("additionalContext"), false);
  assert.equal(result.out.includes('"decision"'), false);
  assert.ok(result.out.trim().length > 0);
});

test("Stop skip_skills from session pointer only", async () => {
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
  const transcript = join(tmp("devkit-hook-tr-"), "transcript.jsonl");
  writeTranscript(transcript, [skillTranscriptRow("superpowers")]);
  const start = await runHook(
    "session-start",
    sessionStartPayload(repo, { transcriptPath: transcript }),
    env,
    { path: repo },
  );
  assert.equal(start.code, 0);
  const pointer = JSON.parse(readFileSync(ctx.paths.sessionPointerFile, "utf8")) as {
    skills?: string[];
  };
  assert.ok(pointer.skills?.includes("superpowers"));
  const config = writeBlockingConfig(["  skip_skills:", "    - superpowers"]);
  evidenceSpawnCalls.length = 0;
  const result = await runHook("stop", stopPayload(repo, { text: "that's all" }), env, {
    path: repo,
    config,
  });
  assert.equal(result.code, 0);
  assert.equal(evidenceSpawnCalls.length, 0);
  assert.equal(existsSync(mark), false);
  assert.equal(result.out.includes('"decision"'), false);
});

test("Stop stop_blocking true plus failing evidence emits decision block", async () => {
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
  const config = writeBlockingConfig();
  evidenceSpawnCalls.length = 0;
  const result = await runHook("stop", stopPayload(repo, { text: "that's all" }), env, {
    path: repo,
    config,
  });
  assert.equal(result.code, 0);
  assert.equal(existsSync(mark), true);
  const parsed = parseJson(result.out);
  assert.equal(parsed.decision, "block");
  assert.equal("additionalContext" in parsed, false);
  const spec = parsed.hookSpecificOutput;
  if (spec && typeof spec === "object") {
    assert.equal("additionalContext" in spec, false);
  }
});

test("Stop hung evidence with stop_blocking true fails open", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const binDir = tmp("devkit-hook-bin-");
  writeHungNpm(binDir);
  const env = isolatedEnv(dataRoot, { pathPrefix: [binDir] });
  const ctx = await createContext({ repoPath: repo, env });
  await playbookRecord(ctx, {
    raw_command: "npm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 0,
    duration_ms: 12,
  });
  const config = writeBlockingConfig(["  evidence:", "    timeout_ms: 400"]);
  const started = Date.now();
  const result = await runHook("stop", stopPayload(repo, { text: "that's all" }), env, {
    path: repo,
    config,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), "");
  assert.equal(result.out.includes("additionalContext"), false);
  assert.equal(result.out.includes('"decision"'), false);
  assert.ok(elapsed < 5000, `elapsed ${elapsed}ms waited on hung evidence`);
});

test("hook fail-open on bad JSON missing cwd and unknown kind", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const bad = await runHookRaw(["node", "devkit", "--path", repo, "hook", "stop"], "{", env);
  assert.equal(bad.code, 0);
  assert.equal(bad.out, "");
  const missingCwd = await runHook("stop", { hook_event_name: "Stop" }, env, { path: repo });
  assert.equal(missingCwd.code, 0);
  assert.equal(missingCwd.out, "");
  const unknown = await runHook("nonesuch", { cwd: repo, hook_event_name: "Stop" }, env, {
    path: repo,
  });
  assert.equal(unknown.code, 0);
  assert.equal(unknown.out, "");
  const bogus = await runHookRaw(["node", "devkit", "--bogus", "hook", "stop"], "{}", env);
  assert.equal(bogus.code, 0);
  assert.equal(bogus.out, "");
  assert.equal(bogus.err, "");
});

test("SessionStart stale mapping with no CBM is graph missing", async () => {
  const dataRoot = tmp("devkit-hook-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  mkdirSync(ctx.paths.graphDir, { recursive: true });
  writeFileSync(
    ctx.paths.cbmProjectFile,
    `${JSON.stringify({
      version: 1,
      repo_id: ctx.repoId,
      root_path: repo,
      cbm_project: "stale",
      mode: "moderate",
      last_status: "ready",
      last_indexed_at: new Date().toISOString(),
      nodes: 1,
      edges: 1,
    })}\n`,
  );
  const result = await runHook("session-start", sessionStartPayload(repo), env, { path: repo });
  assert.equal(result.code, 0);
  assert.match(additionalContext(result.out), /^graph: missing$/m);
});

test("Claude fragment registers PostToolUseFailure Bash", () => {
  const fragmentPath = fileURLToPath(
    new URL("../../adapters/claude-code/settings.fragment.json", import.meta.url),
  );
  const fragment = JSON.parse(readFileSync(fragmentPath, "utf8")) as {
    hooks?: { PostToolUseFailure?: Array<{ matcher?: string }> };
  };
  const failHooks = fragment.hooks?.PostToolUseFailure ?? [];
  assert.ok(failHooks.some((entry) => entry.matcher === "Bash"));
});
