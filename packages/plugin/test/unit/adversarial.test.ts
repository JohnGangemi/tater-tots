import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AdversarialResult, Finding } from "@coredevkit/platform";
import { createContext } from "@coredevkit/platform";
import {
  runAdversarialCheckpoint,
  shouldRunAdversarial,
} from "../../src/lib/gates/adversarial.js";
import type { CoordinatorRecord, CoordinatorStep } from "../../src/lib/coordinator/types.js";
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
  const dir = tmp("devkit-ar-repo-");
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

function step(id: string, title: string): CoordinatorStep {
  return {
    id,
    step_title: title,
    title,
    status: "pending",
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
    plan_id: "add-adversarial",
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
    resume_step_id: steps[0]?.id ?? null,
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

function finding(
  partial: Partial<Finding> & Pick<Finding, "tag">,
): Finding {
  return {
    id: partial.id ?? "AR-001",
    tag: partial.tag,
    category: partial.category ?? "path",
    claim: partial.claim ?? "claim",
    evidence_type: partial.evidence_type ?? "filesystem",
    evidence: partial.evidence ?? "e",
    plan_target: partial.plan_target ?? "t",
    patch: partial.patch === undefined ? "p" : partial.patch,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-AR-P-01 passed status does not run", () => {
  assert.equal(
    shouldRunAdversarial({
      resolved_level: "full",
      status: "passed",
      verdict: "PASS",
      stepCount: 10,
      stackEnabled: true,
      source: "issue-to-pr",
      minSteps: 4,
    }),
    false,
  );
});

test("T-AR-P-02 level not full is skipped even with many steps", () => {
  for (const level of ["off", "light"] as const) {
    assert.equal(
      shouldRunAdversarial({
        resolved_level: level,
        status: "skipped",
        verdict: null,
        stepCount: 8,
        stackEnabled: false,
        source: "plan",
        minSteps: 4,
      }),
      false,
    );
  }
});

test("T-AR-P-03 full plus step count or stack or issue-to-pr triggers", () => {
  const base = {
    resolved_level: "full" as const,
    status: "skipped" as const,
    verdict: null,
    minSteps: 4,
  };
  assert.equal(
    shouldRunAdversarial({
      ...base,
      stepCount: 4,
      stackEnabled: false,
      source: "plan",
    }),
    true,
  );
  assert.equal(
    shouldRunAdversarial({
      ...base,
      stepCount: 1,
      stackEnabled: true,
      source: "plan",
    }),
    true,
  );
  assert.equal(
    shouldRunAdversarial({
      ...base,
      stepCount: 1,
      stackEnabled: false,
      source: "issue-to-pr",
    }),
    true,
  );
  assert.equal(
    shouldRunAdversarial({
      ...base,
      stepCount: 3,
      stackEnabled: false,
      source: "plan",
    }),
    false,
  );
  assert.equal(
    shouldRunAdversarial({
      ...base,
      status: "skipped",
      verdict: "PATCH",
      stepCount: 8,
      stackEnabled: true,
      source: "issue-to-pr",
    }),
    false,
  );
  assert.equal(
    shouldRunAdversarial({
      ...base,
      status: "blocked",
      verdict: "BLOCK",
      stepCount: 1,
      stackEnabled: false,
      source: "plan",
    }),
    true,
  );
});

test("T-AR-P-06 PATCH apply does not call review again for the same session_id", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env });
  const record = sampleRecord(ctx, [
    step("S1", "Add store"),
    step("S2", "Add tests"),
    step("S3", "Add docs"),
    step("S4", "Add gate"),
  ]);
  mkdirSync(record.plan_dir, { recursive: true });
  const original = `# Plan

## Add coordinator library

1. **S1: Add store** — paths \`src/store.ts\`.
`;
  writeFileSync(record.agent_plan, original);

  let calls = 0;
  const review = async (): Promise<AdversarialResult> => {
    calls += 1;
    return {
      verdict: "PATCH",
      findings: [
        finding({
          tag: "patch-plan",
          plan_target: "Add coordinator library",
          patch: "Add coordinator store",
          evidence_type: "graph",
        }),
      ],
      dropped_illegal: 0,
      plan_path: record.agent_plan,
      graph_ready: false,
      resolved_level: "full",
    };
  };
  const err = { write: () => true } as unknown as NodeJS.WritableStream;
  const first = await runAdversarialCheckpoint({
    ctx,
    record,
    autoPatch: true,
    sessionId: "sess-1",
    review,
    stderr: err,
  });
  assert.equal(first.action, "continue");
  assert.equal(record.adversarial.status, "passed");
  assert.equal(record.adversarial.verdict, "PATCH");
  assert.equal(calls, 1);
  assert.match(readFileSync(record.agent_plan, "utf8"), /Add coordinator store/);

  const second = await runAdversarialCheckpoint({
    ctx,
    record,
    autoPatch: true,
    sessionId: "sess-1",
    review,
    stderr: err,
  });
  assert.equal(second.action, "continue");
  assert.equal(calls, 1);

  record.adversarial.status = "skipped";
  record.adversarial.verdict = "PATCH";
  const waitErr = { write: () => true } as unknown as NodeJS.WritableStream;
  let waitCalls = 0;
  const waitReview = async (): Promise<AdversarialResult> => {
    waitCalls += 1;
    return {
      verdict: "PATCH",
      findings: [
        finding({
          tag: "patch-plan",
          plan_target: "Add coordinator library",
          patch: "Add coordinator store",
          evidence_type: "graph",
        }),
      ],
      dropped_illegal: 0,
      plan_path: record.agent_plan,
      graph_ready: false,
      resolved_level: "full",
    };
  };
  record.adversarial.session_id = null;
  record.adversarial.ran_at = null;
  const waitFirst = await runAdversarialCheckpoint({
    ctx,
    record,
    autoPatch: false,
    sessionId: "sess-2",
    review: waitReview,
    stderr: waitErr,
  });
  assert.equal(waitFirst.action, "wait_accept");
  assert.equal(waitCalls, 1);
  const waitSecond = await runAdversarialCheckpoint({
    ctx,
    record,
    autoPatch: false,
    sessionId: "sess-2",
    review: waitReview,
    stderr: waitErr,
  });
  assert.equal(waitSecond.action, "wait_accept");
  assert.equal(waitCalls, 1);
});
