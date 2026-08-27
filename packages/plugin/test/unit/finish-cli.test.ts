import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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
import type { FinishPacket } from "../../src/lib/finish/command.js";
import { planFilePaths } from "../../src/lib/plan/paths.js";
import { loadPlatform } from "../../src/lib/platform-guard.js";
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
  const dir = tmp("devkit-fin-repo-");
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

function intentJson(agentPlan: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      title: "Add finish",
      summary: "Wrap up steps.",
      goal: "Add finish summary.",
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
          title: "Ship finish",
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
    },
    null,
    2,
  )}\n`;
}

const PLAN_MD = `# Add finish

Goal: Wrap up.

## Steps

1. **S1: Add finish CLI** — paths \`packages/plugin/src/lib/finish/command.ts\`.
2. **S2: Add skip remaining** — paths \`packages/plugin/src/lib/finish/command.ts\`.

## Stack

none
`;

async function startPlan(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof createContext>>> {
  const ctx = await createContext({ repoPath: repo, env });
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(paths.intentPath, intentJson(paths.agentPlan));
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

function failEvidence(verdict: "fail" | "error" | "no_command" | "denied") {
  return {
    ok: false as const,
    verdict,
    command: "pnpm test",
    attempts: 1,
    exit_code: verdict === "error" ? null : 1,
    duration_ms: 1,
    tail: "",
    recorded: "skipped" as const,
    resolved_level: "light" as const,
    timed_out: false,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePluginArgv stores finish --skip-remaining", () => {
  const parsed = parsePluginArgv([
    "node",
    "devkit",
    "finish",
    "--skip-remaining",
  ]);
  assert.equal(parsed.pluginCommand, "finish");
  assert.equal(parsed.skipRemaining, true);
});

test("finish without coordinator succeeds and skips evidence at off", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  let checks = 0;
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "off", "finish"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "evidenceCheck") {
              return async () => {
                checks += 1;
                throw new Error("evidence must not run");
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 0, cap.err());
  assert.equal(checks, 0);
  const packet = JSON.parse(cap.out()) as FinishPacket;
  assert.equal(packet.command, "finish");
  assert.deepEqual(packet.remaining_step_ids, []);
  assert.equal(packet.adversarial_status, null);
  assert.match(cap.err(), /No remaining steps/);
});

test("finish prints remaining steps HTML path stack URLs and adversarial status", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const rec = await loadCoordinator(ctx);
  rec.stack.enabled = true;
  rec.stack.prs = [
    {
      stack_id: "pr1",
      branch: "feat/a",
      base: "main",
      pr_number: 1,
      pr_url: "https://example.test/pr/1",
      pr_state: "created",
      phase: "pr_created",
      commit_sha: "abc",
      allowed_paths: ["a.ts"],
    },
  ];
  rec.adversarial.status = "passed";
  await saveCoordinator(ctx, rec);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "off", "finish"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as FinishPacket;
  assert.deepEqual(packet.remaining_step_ids, ["S1", "S2"]);
  assert.deepEqual(packet.stack_urls, ["https://example.test/pr/1"]);
  assert.equal(packet.adversarial_status, "passed");
  assert.equal(packet.html_path, rec.html_path);
  assert.match(cap.err(), /Remaining S1 S2/);
  assert.match(cap.err(), /plan\.html/);
  assert.match(cap.err(), /https:\/\/example\.test\/pr\/1/);
  assert.match(cap.err(), /Adversarial: passed/);
});

test("finish --skip-remaining marks pending skipped and keeps in_progress", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const rec = await loadCoordinator(ctx);
  rec.steps[0]!.status = "in_progress";
  rec.resume_step_id = "S1";
  await saveCoordinator(ctx, rec);
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "off",
      "finish",
      "--skip-remaining",
    ],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const after = await loadCoordinator(ctx);
  assert.equal(after.steps[0]?.status, "in_progress");
  assert.equal(after.steps[1]?.status, "skipped");
  assert.equal(after.resume_step_id, "S1");
  const packet = JSON.parse(cap.out()) as FinishPacket;
  assert.deepEqual(packet.remaining_step_ids, ["S1"]);
  assert.ok(after.events.some((e) => e.status === "skipped"));
});

test("finish --skip-remaining without coordinator exits 1", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "off",
      "finish",
      "--skip-remaining",
    ],
    env,
    cap.io,
  );
  assert.equal(code, 1, cap.err());
  assert.match(cap.err(), /coordinator file not found/);
});

test("finish light evidence fail exits 2 and does not mark done", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const purposes: unknown[] = [];
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "light", "finish"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "evidenceCheck") {
              return async (_ctx: unknown, input: { purpose?: string }) => {
                purposes.push(input);
                return failEvidence("fail");
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 2, cap.err());
  assert.notEqual(code, 3);
  assert.deepEqual(purposes, [{ purpose: "test" }]);
  const after = await loadCoordinator(ctx);
  assert.equal(after.steps[0]?.status, "pending");
  assert.equal(after.steps[1]?.status, "pending");
});

test("finish evidence error exits 3 not 2", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "full", "finish"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "evidenceCheck") {
              return async () => failEvidence("error");
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 3, cap.err());
  assert.notEqual(code, 2);
  const after = await loadCoordinator(ctx);
  assert.notEqual(after.steps[0]?.status, "done");
});

test("finish --skip-remaining does not skip when evidence fails", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "light",
      "finish",
      "--skip-remaining",
    ],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "evidenceCheck") {
              return async () => failEvidence("denied");
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 2, cap.err());
  const after = await loadCoordinator(ctx);
  assert.equal(after.steps[0]?.status, "pending");
  assert.equal(after.steps[1]?.status, "pending");
});

test("finish does not fail when adversarial status is skipped", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await startPlan(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "off", "finish"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as FinishPacket;
  assert.equal(packet.adversarial_status, "skipped");
  assert.match(cap.err(), /Adversarial: skipped/);
});
