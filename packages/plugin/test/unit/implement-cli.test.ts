import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createContext } from "@coredevkit/platform";
import {
  parsePluginArgv,
  runPluginCli,
  type PluginCliIo,
} from "../../src/cli.js";
import {
  loadCoordinator,
  saveCoordinator,
} from "../../src/lib/coordinator/store.js";
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
  const dir = tmp("devkit-imp-repo-");
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

function intentJson(
  agentPlan: string,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify(
    {
      version: 1,
      title: "Add implement",
      summary: "Resume and mark steps.",
      goal: "Add implement resume and evidence gate.",
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
          title: "Ship implement",
          complete: true,
          steps: [
            {
              id: "PS1",
              title: "Resume",
              detail: "Add CLI.",
              required: true,
            },
          ],
        },
      ],
      sequences: [],
      stack: [],
      risks: [],
      ...extra,
    },
    null,
    2,
  )}\n`;
}

const PLAN_MD = `# Add implement

Goal: Resume steps.

## Steps

1. **S1: Add implement CLI** — paths \`packages/plugin/src/lib/implement/command.ts\`.
2. **S2: Add evidence gate** — paths \`packages/plugin/src/lib/gates/evidence.ts\`.

## Stack

none
`;

async function startPlan(
  repo: string,
  env: NodeJS.ProcessEnv,
  extraIntent: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof createContext>>> {
  const ctx = await createContext({ repoPath: repo, env });
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(paths.intentPath, intentJson(paths.agentPlan, extraIntent));
  writeFileSync(paths.agentPlan, PLAN_MD);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "plan", "--start-coordinator"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  return ctx;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePluginArgv stores implement flags", () => {
  const parsed = parsePluginArgv([
    "node",
    "devkit",
    "implement",
    "--step",
    "S2",
    "--mark",
    "done",
    "--evidence-command",
    "pnpm test",
    "--evidence-purpose",
    "test",
    "--force-evidence",
  ]);
  assert.equal(parsed.pluginCommand, "implement");
  assert.equal(parsed.step, "S2");
  assert.equal(parsed.mark, "done");
  assert.equal(parsed.evidenceCommand, "pnpm test");
  assert.equal(parsed.evidencePurpose, "test");
  assert.equal(parsed.forceEvidence, true);
});

test("T-CFG-P-01 CLI --verification full is resolved_level full", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await startPlan(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "full", "implement"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as { resolved_level?: string };
  assert.equal(packet.resolved_level, "full");
});

test("T-SA-01 swapped subagents.coder is the packet agent", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  mkdirSync(join(repo, ".devkit"), { recursive: true });
  writeFileSync(
    join(repo, ".devkit", "config.yaml"),
    "subagents:\n  coder: my-coder\n",
  );
  await startPlan(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "implement"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as {
    dispatch?: { role?: string; agent?: string } | null;
    packet?: { agent?: string; role?: string };
  };
  assert.equal(packet.dispatch?.role, "coder");
  assert.equal(packet.dispatch?.agent, "my-coder");
  assert.equal(packet.packet?.agent, "my-coder");
});

test("T-AR-P-08 blocking open questions exit 2", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env, {
    open_questions: [
      {
        id: "Q1",
        ask: "Which store?",
        why_it_matters: "Blocks implement.",
        blocks: true,
        options: ["user-data"],
        status: "open",
        answer: null,
      },
    ],
  });
  const rec = await loadCoordinator(ctx);
  assert.deepEqual(rec.blocking_open_question_ids, ["Q1"]);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "implement"],
    env,
    cap.io,
  );
  assert.equal(code, 2, cap.err());
  assert.match(cap.err(), /blocking open questions/);
  assert.match(cap.err(), /Q1/);
  const after = await loadCoordinator(ctx);
  assert.equal(after.steps[0]?.status, "pending");
  assert.equal(after.resume_step_id, "S1");
});

test("T-AR-P-08b resolve questions then start-coordinator without replace", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env, {
    open_questions: [
      {
        id: "Q1",
        ask: "Which store?",
        why_it_matters: "Blocks implement.",
        blocks: true,
        options: ["user-data"],
        status: "open",
        answer: null,
      },
    ],
  });
  const first = await loadCoordinator(ctx);
  first.events.push({
    step_title: first.steps[0]?.step_title ?? "Add implement CLI",
    status: "pending",
    at: first.created_at,
  });
  await saveCoordinator(ctx, first);
  const resumeBefore = first.resume_step_id;
  const eventsBefore = first.events.length;

  const blockCap = captureIo();
  const blockCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "implement"],
    env,
    blockCap.io,
  );
  assert.equal(blockCode, 2);

  const wt = worktreeHash(ctx.repoPath);
  const paths = planFilePaths(join(ctx.paths.plansDir, wt.worktree_hash));
  const raw = JSON.parse(readFileSync(paths.intentPath, "utf8")) as {
    open_questions: Array<{
      id: string;
      status: string;
      answer: string | null;
      blocks: boolean;
      ask: string;
      why_it_matters: string;
      options: string[];
    }>;
  };
  const q = raw.open_questions.find((item) => item.id === "Q1");
  assert.ok(q);
  q.status = "resolved";
  q.answer = "user-data";
  writeFileSync(paths.intentPath, `${JSON.stringify(raw, null, 2)}\n`);

  const mergeCap = captureIo();
  const mergeCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "plan", "--start-coordinator"],
    env,
    mergeCap.io,
  );
  assert.equal(mergeCode, 0, mergeCap.err());
  const merged = await loadCoordinator(ctx);
  assert.deepEqual(merged.blocking_open_question_ids, []);
  assert.equal(merged.resume_step_id, resumeBefore);
  assert.equal(merged.events.length, eventsBefore);
  assert.equal(merged.plan_id, first.plan_id);

  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "implement"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as { resume_step_id?: string };
  assert.equal(packet.resume_step_id, "S1");
  const after = await loadCoordinator(ctx);
  assert.equal(after.steps[0]?.status, "in_progress");
});
