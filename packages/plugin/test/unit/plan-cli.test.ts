import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { createContext } from "@coredevkit/platform";
import { runPluginCli, type PluginCliIo } from "../../src/cli.js";
import { loadCoordinator } from "../../src/lib/coordinator/store.js";
import { planFilePaths } from "../../src/lib/plan/paths.js";
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
  const dir = tmp("devkit-pl-repo-");
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

function captureIo(): {
  io: PluginCliIo;
  out: () => string;
  err: () => string;
} {
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

function sixSteps() {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `PS${i + 1}`,
    title: `Process step A${i + 1}`,
    detail: `Do step ${i + 1}.`,
    required: true,
  }));
}

function writeFixtures(planDir: string, agentPlan: string): void {
  mkdirSync(planDir, { recursive: true });
  const intent = {
    version: 1,
    title: "Add writing-plans",
    summary: "Ship intent HTML and plan CLI.",
    goal: "Add writing-plans and intent HTML.",
    agent_plan: agentPlan,
    theme_default: "system",
    non_goals: [],
    constraints: [],
    assumptions: [],
    open_questions: [],
    components: [
      { id: "c1", name: "plugin", path: "packages/plugin", role: "lib" },
    ],
    processes: [
      {
        id: "p1",
        title: "Ship plan",
        complete: true,
        steps: sixSteps(),
      },
    ],
    sequences: [],
    stack: [],
    risks: [],
  };
  writeFileSync(
    join(planDir, "plan.intent.json"),
    `${JSON.stringify(intent, null, 2)}\n`,
  );
  writeFileSync(
    join(planDir, "plan.md"),
    `# Add writing-plans

Goal: Ship intent HTML.

## Steps

1. **S1: Add intent schema** — paths \`packages/plugin/src/lib/plan/intent.ts\`. Evidence: \`pnpm test\`.
2. **S2: Add HTML renderer** — paths \`packages/plugin/src/lib/plan/render-html.ts\`.

## Evidence

Default: \`pnpm test\`

## Stack

none
`,
  );
}

function writeMapping(ctx: Awaited<ReturnType<typeof createContext>>): void {
  mkdirSync(dirname(ctx.paths.cbmProjectFile), { recursive: true });
  writeFileSync(
    ctx.paths.cbmProjectFile,
    `${JSON.stringify({
      version: 1,
      repo_id: ctx.repoId,
      root_path: ctx.repoPath,
      cbm_project: "fake",
      mode: "fast",
      last_status: "ready",
      last_indexed_at: "2026-08-27T00:00:00Z",
      nodes: 1,
      edges: 0,
    })}\n`,
  );
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-PL-01 render and start-coordinator write under user-data plans dir", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  writeFixtures(planDir, paths.agentPlan);

  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "plan",
      "--render",
      "--start-coordinator",
    ],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  assert.equal(existsSync(paths.intentPath), true);
  assert.equal(existsSync(paths.agentPlan), true);
  assert.equal(existsSync(paths.htmlPath), true);
  const html = readFileSync(paths.htmlPath, "utf8");
  assert.equal((html.match(/data-kind="process-step"/g) ?? []).length, 6);
  assert.match(html, /Generated from plan.intent.json/);
  assert.ok(paths.htmlPath.startsWith(ctx.paths.plansDir));
  assert.equal(existsSync(join(repo, "plan.intent.json")), false);
  assert.equal(existsSync(join(repo, "plan.md")), false);
  assert.equal(existsSync(join(repo, "plan.html")), false);
  assert.equal(existsSync(join(repo, ".devkit", "plans")), false);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.plan_dir, planDir);
  assert.equal(rec.steps.length, 2);
  assert.equal(rec.steps[0]?.id, "S1");
  assert.equal(rec.resume_step_id, "S1");
  assert.match(cap.err(), /plan\.html/);
  assert.doesNotMatch(cap.out(), /"version":\s*1/);

  const goalRepo = makeRepo();
  const goalEnv = isolatedEnv(tmp("devkit-data-goal-"));
  const goalCtx = await createContext({ repoPath: goalRepo, env: goalEnv });
  writeMapping(goalCtx);
  const goalCap = captureIo();
  const goalCode = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      goalRepo,
      "plan",
      "--goal",
      "invent a plan from the goal",
    ],
    goalEnv,
    goalCap.io,
  );
  assert.equal(goalCode, 0, goalCap.err());
  const packet = JSON.parse(goalCap.out()) as {
    command?: string;
    plan_dir?: string;
    packet?: { goal?: string };
  };
  assert.equal(packet.command, "plan");
  assert.equal(packet.packet?.goal, "invent a plan from the goal");
  const goalPlanDir = join(
    goalCtx.paths.plansDir,
    worktreeHash(goalCtx.repoPath).worktree_hash,
  );
  assert.equal(existsSync(join(goalPlanDir, "plan.intent.json")), false);
  assert.equal(existsSync(join(goalPlanDir, "plan.md")), false);
  assert.equal(existsSync(join(goalPlanDir, "plan.html")), false);
  assert.equal(existsSync(join(goalRepo, "plan.intent.json")), false);
  if (existsSync(join(goalRepo, ".devkit"))) {
    const names = readdirSync(join(goalRepo, ".devkit"));
    assert.equal(names.includes("plans"), false);
  }

  const missCap = captureIo();
  const missCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "plan", "--goal", "no mapping"],
    env,
    missCap.io,
  );
  assert.equal(missCode, 3);
  assert.match(missCap.err(), /run devkit init/);
});
