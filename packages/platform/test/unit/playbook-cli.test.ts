import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgv, runCli, type CliIo } from "../../src/cli.js";
import { createContext } from "../../src/lib/context.js";
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
  const dir = tmp("devkit-pbcli-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function isolatedEnv(dataRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
  };
  delete env.DEVKIT_PLAYBOOK_RESET;
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

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("devkit playbook show prints truncated rows", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  const long = `npm run ${"a".repeat(120)}`;
  assert.equal(
    (
      await playbookRecord(ctx, {
        raw_command: long,
        tool_name: "Bash",
        cwd: repo,
        exit_code: 0,
        duration_ms: 10,
      })
    ).result,
    "stored",
  );
  const cap = captureIo();
  const code = await runCli(["node", "devkit", "--path", repo, "playbook", "show"], env, cap.io);
  assert.equal(code, 0);
  const text = cap.out();
  assert.match(text, /^key\tstatus\tcount\tcommand\n/m);
  const line = text.trim().split("\n")[1] ?? "";
  const command = line.split("\t")[3] ?? "";
  assert.ok(command.length <= 80);
  assert.match(command, /\.\.\.$/);
});

test("devkit playbook show --limit caps at 100 and defaults to 20", async () => {
  const parsed = parseArgv(["node", "devkit", "playbook", "show", "--limit", "1000"]);
  assert.equal(parsed.command, "playbook");
  assert.deepEqual(parsed.rest, ["show", "--limit", "1000"]);

  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const cap = captureIo();
  const code = await runCli(
    ["node", "devkit", "--path", repo, "playbook", "show", "--limit", "5"],
    env,
    cap.io,
  );
  assert.equal(code, 0);
  assert.match(cap.out(), /^key\tstatus\tcount\tcommand\n$/);
});

test("devkit playbook stats prints counts only", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  await playbookRecord(ctx, {
    raw_command: "npm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 0,
    duration_ms: 10,
  });
  const cap = captureIo();
  const code = await runCli(["node", "devkit", "--path", repo, "playbook", "stats"], env, cap.io);
  assert.equal(code, 0);
  const stats = JSON.parse(cap.out()) as {
    entries: number;
    max_entries: number;
    filter: string;
    pass: number;
    fail: number;
    by_purpose: { test: number };
  };
  assert.equal(stats.entries, 1);
  assert.equal(stats.max_entries, 500);
  assert.equal(stats.filter, "medium");
  assert.equal(stats.pass, 1);
  assert.equal(stats.fail, 0);
  assert.equal(stats.by_purpose.test, 1);
});

test("devkit playbook without show or stats exits 1", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const cap = captureIo();
  const code = await runCli(
    ["node", "devkit", "--path", repo, "playbook"],
    isolatedEnv(dataRoot),
    cap.io,
  );
  assert.equal(code, 1);
  assert.match(cap.err(), /show or stats/);
});
