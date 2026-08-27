import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createContext } from "@coredevkit/platform";
import { PluginError } from "../../src/lib/errors.js";
import {
  progressFilePath,
  saveCoordinator,
} from "../../src/lib/coordinator/store.js";
import type {
  CoordinatorRecord,
  CoordinatorStep,
} from "../../src/lib/coordinator/types.js";
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
  const dir = tmp("devkit-prj-repo-");
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

function sample(
  ctx: Awaited<ReturnType<typeof createContext>>,
): CoordinatorRecord {
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const now = "2026-08-27T12:00:00Z";
  const s: CoordinatorStep = {
    id: "S1",
    step_title: "Only",
    title: "Only",
    status: "pending",
    allowed_paths: [],
    evidence: null,
    summaries: [],
    blocked_reason: null,
    stack_id: null,
  };
  return {
    version: 1,
    repo_id: ctx.repoId,
    worktree_hash: wt.worktree_hash,
    worktree_sha256: wt.worktree_sha256,
    plan_id: "x",
    plan_dir: planDir,
    intent_path: join(planDir, "plan.intent.json"),
    agent_plan: join(planDir, "plan.md"),
    html_path: join(planDir, "plan.html"),
    source: "plan",
    issue: null,
    pipeline_phase: null,
    created_at: now,
    updated_at: now,
    verification_level: "light",
    adversarial: {
      status: "skipped",
      verdict: null,
      ran_at: null,
      session_id: null,
      findings_hash: null,
    },
    resume_step_id: "S1",
    blocking_open_question_ids: [],
    stack: { enabled: false, default_branch: "main", prs: [] },
    events: [],
    steps: [s],
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-PRJ-01 project progress_location without gitignore exits 1 and writes nothing", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, ".devkit"), { recursive: true });
  writeFileSync(
    join(repo, ".devkit", "config.yaml"),
    "plugin:\n  progress_location: project\n",
  );
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  assert.throws(
    () => progressFilePath(ctx),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.equal((err as PluginError).code, "usage");
      assert.equal(
        (err as PluginError).message,
        "refusing .devkit/progress.yaml because .devkit/ is not gitignored",
      );
      return true;
    },
  );
  await assert.rejects(() => saveCoordinator(ctx, sample(ctx)), PluginError);
  assert.equal(existsSync(join(repo, ".devkit", "progress.yaml")), false);
});
