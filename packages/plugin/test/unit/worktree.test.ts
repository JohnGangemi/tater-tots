import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createContext } from "@coredevkit/platform";
import { progressFilePath } from "../../src/lib/coordinator/store.js";
import { worktreeHash } from "../../src/lib/worktree.js";

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
  const dir = tmp("devkit-wt-repo-");
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

function isolatedEnv(dataRoot: string): NodeJS.ProcessEnv {
  const home = tmp("devkit-home-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
    HOME: home,
    USERPROFILE: home,
  };
  delete env.DEVKIT_CONFIG;
  return env;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-WT-01 two worktrees yield two progress files and one repo_id", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const wt2 = tmp("devkit-wt2-");
  git(repo, ["worktree", "add", "-b", "other", wt2]);
  const env = isolatedEnv(dataRoot);
  const ctx1 = await createContext({ repoPath: repo, env });
  const ctx2 = await createContext({ repoPath: wt2, env });
  assert.equal(ctx1.repoId, ctx2.repoId);
  const h1 = worktreeHash(ctx1.repoPath);
  const h2 = worktreeHash(ctx2.repoPath);
  assert.notEqual(h1.worktree_hash, h2.worktree_hash);
  const p1 = progressFilePath(ctx1);
  const p2 = progressFilePath(ctx2);
  assert.equal(p1, join(ctx1.paths.progressDir, `${h1.worktree_hash}.yaml`));
  assert.equal(p2, join(ctx2.paths.progressDir, `${h2.worktree_hash}.yaml`));
  assert.notEqual(p1, p2);
  assert.equal(ctx1.paths.progressDir, ctx2.paths.progressDir);
});
