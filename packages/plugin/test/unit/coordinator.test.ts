import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { parse as parseYaml } from "yaml";
import { createContext, ingestProgress } from "@coredevkit/platform";
import { PluginError } from "../../src/lib/errors.js";
import { writeProgressAtomic } from "../../src/lib/fs-user.js";
import { resumeStep } from "../../src/lib/coordinator/resume.js";
import {
  loadCoordinator,
  markStep,
  progressFilePath,
  saveCoordinator,
} from "../../src/lib/coordinator/store.js";
import type {
  CoordinatorRecord,
  CoordinatorStep,
  StackPr,
  StepStatus,
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
  const dir = tmp("devkit-co-repo-");
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
  delete env.DEVKIT_PLAN;
  delete env.DEVKIT_VERIFICATION;
  delete env.DEVKIT_PATH;
  return env;
}

function step(id: string, title: string, status: StepStatus): CoordinatorStep {
  return {
    id,
    step_title: title,
    title,
    status,
    allowed_paths: [],
    evidence: null,
    summaries: [],
    blocked_reason: null,
    stack_id: null,
  };
}

function sampleRecord(
  ctx: Awaited<ReturnType<typeof createContext>>,
  steps: CoordinatorStep[],
  extra: Partial<CoordinatorRecord> = {},
): CoordinatorRecord {
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const now = "2026-08-27T12:00:00Z";
  return {
    version: 1,
    repo_id: ctx.repoId,
    worktree_hash: wt.worktree_hash,
    worktree_sha256: wt.worktree_sha256,
    plan_id: "add-coordinator",
    plan_dir: planDir,
    intent_path: join(planDir, "plan.intent.json"),
    agent_plan: join(planDir, "plan.md"),
    html_path: join(planDir, "plan.html"),
    source: "plan",
    issue: null,
    pipeline_phase: null,
    created_at: now,
    updated_at: now,
    verification_level: ctx.config.resolved_level,
    adversarial: {
      status: "skipped",
      verdict: null,
      ran_at: null,
      session_id: null,
      findings_hash: null,
    },
    resume_step_id:
      steps.find((s) => s.status === "in_progress" || s.status === "pending")
        ?.id ?? null,
    blocking_open_question_ids: [],
    stack: {
      enabled: false,
      default_branch: "main",
      prs: [],
    },
    events: [],
    steps,
    ...extra,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-CO-01 kill mid-step leftover dead pid lock resumes S2", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const rec = sampleRecord(ctx, [
    step("S1", "First", "done"),
    step("S2", "Second", "in_progress"),
  ]);
  rec.resume_step_id = "S2";
  rec.events = [
    { step_title: "First", status: "done", at: rec.created_at },
    { step_title: "Second", status: "in_progress", at: rec.created_at },
  ];
  await saveCoordinator(ctx, rec);

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const pid = child.pid;
  assert.ok(pid);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });

  const wt = worktreeHash(ctx.repoPath);
  const lockDir = join(
    ctx.paths.progressDir,
    ".locks",
    `${wt.worktree_hash}.lock`,
  );
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "lock.json"),
    `${JSON.stringify({ pid, started_at: new Date().toISOString() })}\n`,
  );

  const loaded = await loadCoordinator(ctx);
  assert.equal(loaded.resume_step_id, "S2");
  assert.equal(loaded.steps.find((s) => s.id === "S2")?.status, "in_progress");
});

test("T-CO-02 done on last step sets resume_step_id null", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const rec = sampleRecord(ctx, [
    step("S1", "First", "done"),
    step("S2", "Last", "pending"),
  ]);
  rec.resume_step_id = "S2";
  rec.events = [{ step_title: "First", status: "done", at: rec.created_at }];
  await saveCoordinator(ctx, rec);
  const out = await markStep(ctx, "S2", "done");
  assert.equal(out.resume_step_id, null);
});

test("T-CO-03 status enum rejects complete and failed", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const rec = sampleRecord(ctx, [step("S1", "Only", "pending")]);
  await saveCoordinator(ctx, rec);
  await assert.rejects(
    () => markStep(ctx, "S1", "complete" as StepStatus),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.match((err as PluginError).message, /Invalid step status/);
      return true;
    },
  );
  const dest = progressFilePath(ctx);
  const bad = rec;
  (bad.steps[0] as { status: string }).status = "failed";
  await assert.rejects(
    () => saveCoordinator(ctx, bad),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.equal((err as PluginError).message, "coordinator file is corrupt");
      return true;
    },
  );
  writeFileSync(
    dest,
    "version: 1\nsteps:\n  - id: S1\n    status: complete\n    step_title: x\n",
  );
  await assert.rejects(
    () => loadCoordinator(ctx),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.equal((err as PluginError).message, "coordinator file is corrupt");
      return true;
    },
  );
});

test("T-CO-04 atomic write uses progressDir/.tmp and round-trips", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const rec = sampleRecord(ctx, [step("S1", "Only", "pending")]);
  rec.events = [{ step_title: "Only", status: "pending", at: rec.created_at }];
  await saveCoordinator(ctx, rec);
  const loaded = await loadCoordinator(ctx);
  assert.equal(loaded.plan_id, rec.plan_id);
  assert.equal(loaded.steps[0]?.status, "pending");
  assert.deepEqual(
    loaded.steps.map((s) => s.id),
    rec.steps.map((s) => s.id),
  );

  const names = readdirSync(ctx.paths.progressDir);
  const tmpish = names.filter((n) => {
    const p = join(ctx.paths.progressDir, n);
    try {
      return statSync(p).isFile() && n.includes(".tmp-");
    } catch {
      return false;
    }
  });
  assert.deepEqual(tmpish, []);
  assert.ok(names.includes(".tmp"));
  assert.ok(statSync(join(ctx.paths.progressDir, ".tmp")).isDirectory());

  const dest = progressFilePath(ctx);
  const old = readFileSync(dest, "utf8");
  const tmpDir = join(ctx.paths.progressDir, ".tmp");
  writeFileSync(join(tmpDir, "crash-before-rename.yaml"), "version: 1\n");
  assert.equal(readFileSync(dest, "utf8"), old);

  await writeProgressAtomic(
    join(ctx.paths.progressDir, "probe.yaml"),
    "ok\n",
    tmpDir,
  );
  assert.equal(
    readFileSync(join(ctx.paths.progressDir, "probe.yaml"), "utf8"),
    "ok\n",
  );
  const leftover = readdirSync(ctx.paths.progressDir).filter(
    (n) =>
      statSync(join(ctx.paths.progressDir, n)).isFile() && n.includes(".tmp-"),
  );
  assert.deepEqual(leftover, []);
  assert.equal(dirname(dest), ctx.paths.progressDir);
});

test("T-CO-05 blocked then done events ingest step_blocked_then_completed", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const title = "Add coordinator library";
  const rec = sampleRecord(ctx, [step("S1", title, "done")]);
  rec.events = [
    { step_title: title, status: "blocked", at: "2026-08-27T12:01:00Z" },
    { step_title: title, status: "done", at: "2026-08-27T12:02:00Z" },
  ];
  rec.resume_step_id = null;
  await saveCoordinator(ctx, rec);
  await ingestProgress(ctx);
  assert.equal(existsSync(ctx.paths.signalsFile), true);
  const text = readFileSync(ctx.paths.signalsFile, "utf8");
  assert.match(text, /step_blocked_then_completed/);
  const lines = text.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const sig = JSON.parse(lines[0] ?? "{}") as {
    kind?: string;
    fact?: { step_title?: string };
  };
  assert.equal(sig.kind, "step_blocked_then_completed");
  assert.equal(sig.fact?.step_title, title);
});

test("T-CO-06 PR objects have no step_title; pr_state is not a progress record", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const rec = sampleRecord(ctx, [step("S1", "Only", "pending")]);
  rec.stack = {
    enabled: true,
    default_branch: "main",
    prs: [
      {
        stack_id: "A",
        branch: "feat/a",
        base: "main",
        pr_number: null,
        pr_url: null,
        pr_state: "none",
        phase: "none",
        commit_sha: null,
        allowed_paths: ["packages/plugin/src/lib/coordinator/store.ts"],
      },
    ],
  };
  await saveCoordinator(ctx, rec);
  const dest = progressFilePath(ctx);
  const text = readFileSync(dest, "utf8");
  assert.match(text, /pr_state:/);
  const parsed = parseYaml(text) as {
    stack: { prs: Array<Record<string, unknown>> };
    events: unknown[];
    steps: unknown[];
  };
  const pr = parsed.stack.prs[0];
  assert.ok(pr);
  assert.equal("step_title" in pr, false);
  assert.equal("status" in pr, false);
  assert.equal(pr.pr_state, "none");
});

test("T-CO-07 YAML key order emits events before steps", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const rec = sampleRecord(ctx, [step("S1", "Only", "pending")]);
  rec.events = [{ step_title: "Only", status: "pending", at: rec.created_at }];
  await saveCoordinator(ctx, rec);
  const text = readFileSync(progressFilePath(ctx), "utf8");
  assert.ok(text.indexOf("\nevents:") < text.indexOf("\nsteps:"));
  const parsed = parseYaml(text) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  assert.ok(keys.indexOf("events") < keys.indexOf("steps"));
});

function stackPr(stack_id: string, phase: StackPr["phase"]): StackPr {
  return {
    stack_id,
    branch: `feat/${stack_id}`,
    base: "main",
    pr_number: null,
    pr_url: null,
    pr_state: "none",
    phase,
    commit_sha: null,
    allowed_paths: [],
  };
}

test("resume after done stays in the current stack item", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const s1 = step("S1", "A last", "done");
  s1.stack_id = "A";
  const s2 = step("S2", "B first", "pending");
  s2.stack_id = "B";
  const rec = sampleRecord(ctx, [s1, s2]);
  rec.resume_step_id = "S1";
  rec.stack = {
    enabled: true,
    default_branch: "main",
    prs: [stackPr("A", "checked_out"), stackPr("B", "none")],
  };
  assert.equal(resumeStep(rec), null);

  rec.stack.prs[0] = stackPr("A", "pr_created");
  assert.equal(resumeStep(rec), "S2");
});

test("resume does not walk every step when no item is checked_out", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  const s1 = step("S1", "A last", "done");
  s1.stack_id = "A";
  const s2 = step("S2", "B first", "pending");
  s2.stack_id = "B";
  const rec = sampleRecord(ctx, [s1, s2]);
  rec.resume_step_id = "S1";
  rec.stack = {
    enabled: true,
    default_branch: "main",
    prs: [stackPr("A", "none"), stackPr("B", "none")],
  };
  assert.equal(resumeStep(rec), null);
});
