import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { compress, decompress } from "@mongodb-js/zstd";
import { createContext } from "../../src/lib/context.js";
import { PlatformError } from "../../src/lib/errors.js";
import { normalizeCommand, pathExistsInRepo } from "../../src/lib/playbook/normalize.js";
import {
  playbookList,
  playbookLookup,
  playbookRecord,
  type ObserveEvent,
} from "../../src/lib/playbook/store.js";
import { redactArgv } from "../../src/lib/redact.js";

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
  const dir = tmp("devkit-pb-repo-");
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

function bash(cwd: string, cmd: string, extra: Partial<ObserveEvent> = {}): ObserveEvent {
  return {
    raw_command: cmd,
    tool_name: "Bash",
    cwd,
    exit_code: 0,
    duration_ms: 10,
    ...extra,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-PB-01 ls -lah is excluded and never stored", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await playbookRecord(ctx, bash(repo, "ls -lah"));
  assert.equal(out.result, "excluded");
  assert.equal(existsSync(ctx.paths.playbookFile), false);
  const hits = await playbookLookup(ctx, { prefix: "ls" });
  assert.equal(hits.commands.length, 0);
});

test("T-PB-02 pwd, cat README.md, and git status are excluded", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  writeFileSync(join(repo, "README.md"), "hi\n");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  assert.equal((await playbookRecord(ctx, bash(repo, "pwd"))).result, "excluded");
  assert.equal((await playbookRecord(ctx, bash(repo, "cat README.md"))).result, "excluded");
  assert.equal((await playbookRecord(ctx, bash(repo, "git status"))).result, "excluded");
  assert.equal(existsSync(ctx.paths.playbookFile), false);
});

test("T-PB-03 npm test is stored with purpose test", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await playbookRecord(ctx, bash(repo, "npm test"));
  assert.equal(out.result, "stored");
  const hits = await playbookLookup(ctx, { purpose: "test" });
  assert.equal(hits.commands.length, 1);
  assert.equal(hits.commands[0]?.command, "npm test");
  assert.deepEqual(hits.commands[0]?.purpose_tags, ["test"]);
  assert.equal(hits.commands[0]?.last_status, "pass");
});

test("T-PB-04 command with --token is redacted and dropped", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await playbookRecord(ctx, bash(repo, "npm test --token aabbccdd1122"));
  assert.equal(out.result, "redacted");
  assert.equal(existsSync(ctx.paths.playbookFile), false);
});

test("T-PB-05 high-entropy flag value of unknown kind is dropped", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await playbookRecord(ctx, bash(repo, "npm test --foo n7Kq9Xm2Rp4Vt8Lw3YcB"));
  assert.equal(out.result, "redacted");
  assert.equal(existsSync(ctx.paths.playbookFile), false);
});

test("T-PB-06 normalize repo path to ./src/x and keep a stable key", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "x"), "x");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const abs = join(ctx.repoPath, "src", "x");
  const cmd = `  ${abs}  `;
  const first = await playbookRecord(ctx, bash(repo, cmd, { duration_ms: 4000 }));
  const second = await playbookRecord(ctx, bash(repo, cmd, { duration_ms: 4000 }));
  assert.equal(first.result, "stored");
  assert.equal(second.result, "stored");
  const rows = await playbookList(ctx, 20);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.command, "./src/x");
  assert.equal(rows[0]?.key, "./src/x");
  assert.equal(rows[0]?.run_count, 2);
});

test("T-PB-07 filter high does not store duration plus path without hard include", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "hello.js"), "1\n");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  ctx.config.playbook.filter = "high";
  const out = await playbookRecord(ctx, bash(repo, "node ./src/hello.js", { duration_ms: 4000 }));
  assert.equal(out.result, "excluded");
  assert.equal(existsSync(ctx.paths.playbookFile), false);
});

test("T-PB-08 filter low stores a command with one signal", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  ctx.config.playbook.filter = "low";
  const out = await playbookRecord(ctx, bash(repo, "node -e 1", { duration_ms: 4000 }));
  assert.equal(out.result, "stored");
  const hits = await playbookLookup(ctx, { prefix: "node" });
  assert.equal(hits.commands.length, 1);
  assert.equal(hits.commands[0]?.command, "node -e 1");
});

test("T-PB-09 LRU evicts the oldest lru_at when over max_entries", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  ctx.config.playbook.max_entries = 2;
  assert.equal((await playbookRecord(ctx, bash(repo, "npm run one"))).result, "stored");
  assert.equal((await playbookRecord(ctx, bash(repo, "npm run two"))).result, "stored");
  assert.equal((await playbookRecord(ctx, bash(repo, "npm run three"))).result, "stored");
  const rows = await playbookList(ctx, 20);
  assert.equal(rows.length, 2);
  const commands = rows.map((r) => r.command).sort();
  assert.deepEqual(commands, ["npm run three", "npm run two"]);
});

test("T-PB-10 failed worthy command is stored when keep_failures is true", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  assert.equal(ctx.config.playbook.keep_failures, true);
  const out = await playbookRecord(ctx, bash(repo, "npm test", { exit_code: 1 }));
  assert.equal(out.result, "stored");
  const hits = await playbookLookup(ctx, { purpose: "test" });
  assert.equal(hits.commands.length, 1);
  assert.equal(hits.commands[0]?.last_status, "fail");
  assert.equal(hits.commands[0]?.last_exit, 1);
});

test("T-PB-11 compress(buf, 3) then decompress returns the same object", async () => {
  const obj = {
    version: 1 as const,
    repo_id: "abc",
    updated_at: "2026-01-01T00:00:00.000Z",
    entries: [{ key: "npm test", command: "npm test", argv: ["npm", "test"] }],
  };
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  const zst = await compress(buf, 3);
  const back = JSON.parse((await decompress(zst)).toString("utf8"));
  assert.deepEqual(back, obj);

  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  assert.equal((await playbookRecord(ctx, bash(repo, "npm test"))).result, "stored");
  const disk = await decompress(readFileSync(ctx.paths.playbookFile));
  const stored = JSON.parse(disk.toString("utf8")) as {
    version: number;
    entries: Array<{ command: string; argv: string[] }>;
  };
  assert.equal(stored.version, 1);
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0]?.command, "npm test");
  assert.deepEqual(stored.entries[0]?.argv, ["npm", "test"]);
});

test("playbook_lookup returns at most five hits", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  for (const name of ["a", "b", "c", "d", "e", "f"]) {
    assert.equal((await playbookRecord(ctx, bash(repo, `npm run ${name}`))).result, "stored");
  }
  const hits = await playbookLookup(ctx, { prefix: "npm run" });
  assert.equal(hits.commands.length, 5);
});

test("two worktrees share one playbook file", async () => {
  const dataRoot = tmp("devkit-data-");
  const env = isolatedEnv(dataRoot);
  const main = makeRepo();
  const wt = join(tmp("devkit-wt-base-"), "wt");
  git(main, ["worktree", "add", "--detach", wt]);
  const ctxMain = await createContext({ repoPath: main, env });
  const ctxWt = await createContext({ repoPath: wt, env });
  assert.equal(ctxMain.paths.playbookFile, ctxWt.paths.playbookFile);
  assert.equal((await playbookRecord(ctxMain, bash(main, "npm test"))).result, "stored");
  const hits = await playbookLookup(ctxWt, { purpose: "test" });
  assert.equal(hits.commands.length, 1);
  assert.equal(hits.commands[0]?.command, "npm test");
});

test("corrupt playbook reads empty and refuses writes until reset", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  writeFileSync(ctx.paths.playbookFile, "not-zstd");
  const hits = await playbookLookup(ctx, { prefix: "npm" });
  assert.equal(hits.commands.length, 0);
  await assert.rejects(
    () => playbookRecord(ctx, bash(repo, "npm test")),
    (err: unknown) => err instanceof PlatformError && err.code === "io",
  );
  env.DEVKIT_PLAYBOOK_RESET = "1";
  const stored = await playbookRecord(ctx, bash(repo, "npm test"));
  assert.equal(stored.result, "stored");
  const after = await playbookLookup(ctx, { purpose: "test" });
  assert.equal(after.commands[0]?.command, "npm test");
});

test("path signal counts only paths inside the repo", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "x"), "x");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  assert.equal(pathExistsInRepo(ctx.repoPath, "./src/x"), true);
  assert.equal(pathExistsInRepo(ctx.repoPath, join(ctx.repoPath, "src", "x")), true);
  assert.equal(pathExistsInRepo(ctx.repoPath, process.execPath), false);

  const outside = join(tmp("devkit-outside-"), "outside.txt");
  writeFileSync(outside, "x");
  assert.equal(pathExistsInRepo(ctx.repoPath, outside), false);

  ctx.config.playbook.filter = "medium";
  const out = await playbookRecord(
    ctx,
    bash(repo, `${process.execPath} -e 1`, { duration_ms: 4000 }),
  );
  assert.equal(out.result, "excluded");
});

test("mysql -P is port and is not redacted; -p is password", () => {
  const port = redactArgv(["mysql", "-P", "3306"]);
  assert.equal(port.drop, false);
  assert.deepEqual(port.argv, ["mysql", "-P", "3306"]);
  const portAttached = redactArgv(["mysql", "-P3306"]);
  assert.equal(portAttached.drop, false);
  const pass = redactArgv(["mysql", "-p", "secret"]);
  assert.equal(pass.drop, true);
  const attached = redactArgv(["mysql", "-psecret"]);
  assert.equal(attached.drop, true);
});

test("normalize converts backslash repo paths to ./src/x", () => {
  const repo = "/tmp/foo";
  const norm = normalizeCommand("'/tmp/foo\\src\\x'", repo, repo);
  assert.equal(norm.command, "./src/x");
  assert.equal(norm.key, "./src/x");
  const rel = normalizeCommand("'.\\src\\x'", repo, repo);
  assert.equal(rel.command, "./src/x");
});

test("normalize leaves backslash in regex arguments", () => {
  const norm = normalizeCommand("sed 's/\\./x/'", "/tmp/foo", "/tmp/foo");
  assert.equal(norm.argv[1], "s/\\./x/");
  assert.equal(norm.command, "sed s/\\./x/");
});

test("null exit_code is pass and is not a fail signal", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  ctx.config.playbook.filter = "medium";
  const skipped = await playbookRecord(
    ctx,
    bash(repo, "node -e 1", { duration_ms: 4000, exit_code: null }),
  );
  assert.equal(skipped.result, "excluded");

  const stored = await playbookRecord(ctx, bash(repo, "npm test", { exit_code: null }));
  assert.equal(stored.result, "stored");
  const hits = await playbookLookup(ctx, { purpose: "test" });
  assert.equal(hits.commands[0]?.last_status, "pass");
  assert.equal(hits.commands[0]?.last_exit, 0);
});
