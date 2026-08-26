import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  hashSource,
  isIdentityStub,
  normalizeOriginUrl,
  readIdentity,
  resolveRepoId,
} from "../../src/lib/repo-id.js";
import { resolveDataRoot, userDataPaths } from "../../src/lib/paths.js";

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

function makeRepo(origin?: string): string {
  const dir = tmp("devkit-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  if (origin) {
    git(dir, ["remote", "add", "origin", origin]);
  }
  return dir;
}

function testEnv(dataRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, DEVKIT_DATA_DIR: dataRoot };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-ID-01 Origin git@ and https yield the same repo-id", async () => {
  const a = normalizeOriginUrl("git@github.com:Org/Repo.git");
  const b = normalizeOriginUrl("https://github.com/org/repo");
  assert.equal(a, "https://github.com/org/repo");
  assert.equal(a, b);

  const dataRoot = tmp("devkit-data-");
  const env = testEnv(dataRoot);
  const repoA = makeRepo("git@github.com:Org/Repo.git");
  const repoB = makeRepo("https://github.com/org/repo");
  const idA = await resolveRepoId(repoA, { env });
  const idB = await resolveRepoId(repoB, { env });
  assert.equal(idA.kind, "url");
  assert.equal(idB.kind, "url");
  assert.equal(idA.repo_id, idB.repo_id);
  assert.equal(idA.sha256, idB.sha256);
  assert.equal(idA.source, "https://github.com/org/repo");
});

test("T-ID-02 Two worktrees of the same common-dir share a playbook path", async () => {
  const dataRoot = tmp("devkit-data-");
  const env = testEnv(dataRoot);
  const main = makeRepo();
  const wt = join(tmp("devkit-wt-base-"), "wt");
  git(main, ["worktree", "add", "--detach", wt]);
  const idMain = await resolveRepoId(main, { env });
  const idWt = await resolveRepoId(wt, { env });
  assert.equal(idMain.kind, "common-dir");
  assert.equal(idWt.kind, "common-dir");
  assert.equal(idMain.repo_id, idWt.repo_id);
  const playA = userDataPaths(resolveDataRoot(env), idMain.repo_id, env).playbookFile;
  const playB = userDataPaths(resolveDataRoot(env), idWt.repo_id, env).playbookFile;
  assert.equal(playA, playB);
});

test("T-ID-03 Add origin when URL id is empty moves files", async () => {
  const dataRoot = tmp("devkit-data-");
  const env = testEnv(dataRoot);
  const repo = makeRepo();
  const before = await resolveRepoId(repo, { env });
  assert.equal(before.kind, "common-dir");
  const oldPaths = userDataPaths(resolveDataRoot(env), before.repo_id, env);
  writeFileSync(oldPaths.playbookFile, "old-playbook");
  mkdirSync(oldPaths.overridesDir, { recursive: true });
  writeFileSync(join(oldPaths.overridesDir, "skill.override.md"), "override");

  git(repo, ["remote", "add", "origin", "git@github.com:Org/Repo.git"]);
  const after = await resolveRepoId(repo, { env });
  assert.equal(after.kind, "url");
  assert.equal(after.migrated_from, before.repo_id);
  const newPaths = userDataPaths(resolveDataRoot(env), after.repo_id, env);
  assert.equal(readFileSync(newPaths.playbookFile, "utf8"), "old-playbook");
  assert.equal(readFileSync(join(newPaths.overridesDir, "skill.override.md"), "utf8"), "override");
  const stub = readIdentity(oldPaths.identityFile);
  assert.ok(stub && isIdentityStub(stub));
  assert.equal(stub.migrated_to, after.repo_id);
  assert.equal(
    hashSource(normalizeOriginUrl("git@github.com:Org/Repo.git") ?? "").repo_id,
    after.repo_id,
  );
});

test("T-ID-04 Add origin when URL id already has a playbook does not merge", async () => {
  const dataRoot = tmp("devkit-data-");
  const env = testEnv(dataRoot);
  const origin = "git@github.com:Org/Repo.git";
  const norm = normalizeOriginUrl(origin);
  assert.ok(norm);
  const urlId = hashSource(norm).repo_id;
  const urlPaths = userDataPaths(dataRoot, urlId, env);
  mkdirSync(urlPaths.playbookDir, { recursive: true });
  writeFileSync(urlPaths.playbookFile, "url-playbook");

  const repo = makeRepo();
  const common = await resolveRepoId(repo, { env });
  assert.equal(common.kind, "common-dir");
  const commonPaths = userDataPaths(resolveDataRoot(env), common.repo_id, env);
  writeFileSync(commonPaths.playbookFile, "common-playbook");

  git(repo, ["remote", "add", "origin", origin]);
  const after = await resolveRepoId(repo, { env });
  assert.equal(after.kind, "url");
  assert.equal(after.repo_id, urlId);
  assert.equal(after.migrated_from, null);
  assert.equal(readFileSync(urlPaths.playbookFile, "utf8"), "url-playbook");
  assert.equal(readFileSync(commonPaths.playbookFile, "utf8"), "common-playbook");
  const stub = readIdentity(commonPaths.identityFile);
  assert.ok(stub && !isIdentityStub(stub));
});

test("normalizeOriginUrl strips userinfo, port, and .git", () => {
  assert.equal(
    normalizeOriginUrl("https://user:token@GitHub.com:443/Org/Repo.git/"),
    "https://github.com/org/repo",
  );
  assert.equal(
    normalizeOriginUrl("ssh://git@github.com/Org/Repo.git"),
    "https://github.com/org/repo",
  );
});
