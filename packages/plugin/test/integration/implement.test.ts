import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  createContext,
  playbookList,
  playbookRecord,
} from "@coredevkit/platform";
import { runPluginCli, type PluginCliIo } from "../../src/cli.js";
import {
  loadCoordinator,
  saveCoordinator,
} from "../../src/lib/coordinator/store.js";
import { loadPlatform } from "../../src/lib/platform-guard.js";
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
  const dir = tmp("devkit-in-imp-repo-");
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

function isolatedEnv(
  dataRoot: string,
  extraPath: string[] = [],
): NodeJS.ProcessEnv {
  const home = tmp("devkit-home-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
    HOME: home,
    USERPROFILE: home,
    PATH: [...extraPath, dirname(process.execPath), "/usr/bin", "/bin"].join(
      delimiter,
    ),
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

function writeFailBin(dir: string, name: string, code: number): string {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\nprocess.exit(${code});\n`);
  chmodSync(path, 0o755);
  return path;
}

async function startPlan(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof createContext>>> {
  const ctx = await createContext({ repoPath: repo, env });
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    paths.intentPath,
    `${JSON.stringify(
      {
        version: 1,
        title: "Add implement",
        summary: "Resume and mark steps.",
        goal: "Add implement resume and evidence gate.",
        agent_plan: paths.agentPlan,
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
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    paths.agentPlan,
    `# Add implement

Goal: Resume steps.

## Steps

1. **S1: Add implement CLI** — paths \`packages/plugin/src/lib/implement/command.ts\`. Evidence: \`failcmd\`.
2. **S2: Add evidence gate** — paths \`packages/plugin/src/lib/gates/evidence.ts\`.

## Stack

none
`,
  );
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "plan", "--start-coordinator"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  return ctx;
}

type SpyCounts = {
  lookup: number;
  list: number;
  check: number;
};

function spyPlatform(counts: SpyCounts) {
  return async () => {
    const real = await loadPlatform();
    return new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "playbookLookup") {
          return async (...args: Parameters<typeof real.playbookLookup>) => {
            counts.lookup += 1;
            return real.playbookLookup(...args);
          };
        }
        if (prop === "playbookList") {
          return async (...args: Parameters<typeof real.playbookList>) => {
            counts.list += 1;
            return real.playbookList(...args);
          };
        }
        if (prop === "evidenceCheck") {
          return async (...args: Parameters<typeof real.evidenceCheck>) => {
            counts.check += 1;
            return real.evidenceCheck(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-IN-P-02 implement after start-coordinator prints resume_step_id S1", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "implement"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as {
    resume_step_id?: string;
    command?: string;
    dispatch?: { role?: string } | null;
  };
  assert.equal(packet.command, "implement");
  assert.equal(packet.resume_step_id, "S1");
  assert.equal(packet.dispatch?.role, "coder");
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.resume_step_id, "S1");
  assert.equal(rec.steps[0]?.status, "in_progress");
});

test("T-IN-P-05 mark done fail blocks and does not use playbookLookup", async () => {
  const bin = tmp("devkit-bin-");
  writeFailBin(bin, "failcmd", 1);
  writeFailBin(bin, "pnpm", 1);
  const env = isolatedEnv(tmp("devkit-data-"), [bin]);
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const failCmd = `${join(bin, "failcmd")}`;

  const countsCmd: SpyCounts = { lookup: 0, list: 0, check: 0 };
  const capCmd = captureIo();
  const codeCmd = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "light",
      "implement",
      "--mark",
      "done",
      "--evidence-command",
      failCmd,
    ],
    env,
    capCmd.io,
    { loadPlatform: spyPlatform(countsCmd) },
  );
  assert.equal(codeCmd, 2, capCmd.err());
  assert.ok(countsCmd.check >= 1);
  assert.equal(countsCmd.lookup, 0);
  const blocked = await loadCoordinator(ctx);
  assert.equal(blocked.steps[0]?.status, "blocked");
  assert.equal(blocked.steps[0]?.evidence?.verdict, "fail");
  assert.notEqual(blocked.steps[0]?.status, "done");

  blocked.steps[0]!.status = "pending";
  blocked.steps[0]!.evidence = null;
  blocked.steps[0]!.blocked_reason = null;
  await saveCoordinator(ctx, blocked);

  await playbookRecord(ctx, {
    raw_command: "pnpm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 0,
    duration_ms: 10,
  });
  const countsPurpose: SpyCounts = { lookup: 0, list: 0, check: 0 };
  const capPurpose = captureIo();
  const codePurpose = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "light",
      "implement",
      "--mark",
      "done",
      "--evidence-purpose",
      "test",
    ],
    env,
    capPurpose.io,
    { loadPlatform: spyPlatform(countsPurpose) },
  );
  assert.equal(codePurpose, 2, capPurpose.err());
  assert.ok(countsPurpose.check >= 1);
  assert.equal(countsPurpose.lookup, 0);
  const afterPurpose = await loadCoordinator(ctx);
  assert.equal(afterPurpose.steps[0]?.evidence?.verdict, "fail");

  const rec = await loadCoordinator(ctx);
  rec.steps[0]!.status = "pending";
  rec.steps[0]!.evidence = null;
  rec.steps[0]!.blocked_reason = null;
  const entries = await playbookList(ctx, 50);
  const row = entries.find(
    (e) => e.purpose_tags.includes("test") || e.command.includes("pnpm"),
  );
  assert.ok(row);
  rec.steps[0]!.command_key = row.key;
  await saveCoordinator(ctx, rec);

  const countsList: SpyCounts = { lookup: 0, list: 0, check: 0 };
  const capList = captureIo();
  const codeList = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "light",
      "implement",
      "--mark",
      "done",
    ],
    env,
    capList.io,
    { loadPlatform: spyPlatform(countsList) },
  );
  assert.equal(codeList, 2, capList.err());
  assert.ok(countsList.check >= 1);
  assert.ok(countsList.list >= 1);
  assert.equal(countsList.lookup, 0);
  const afterList = await loadCoordinator(ctx);
  assert.equal(afterList.steps[0]?.status, "blocked");
});

test("T-IN-P-05b evidence error exits 3 and does not mark done", async () => {
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
      "implement",
      "--mark",
      "done",
      "--evidence-command",
      "devkit-no-such-evidence-bin-xyz",
    ],
    env,
    cap.io,
  );
  assert.equal(code, 3, cap.err());
  assert.notEqual(code, 2);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.steps[0]?.status, "blocked");
  assert.equal(rec.steps[0]?.evidence?.verdict, "error");
  assert.notEqual(rec.steps[0]?.status, "done");
});

test("T-IN-P-06 off skips evidence spawn on mark done", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const counts: SpyCounts = { lookup: 0, list: 0, check: 0 };
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "off",
      "implement",
      "--mark",
      "done",
      "--evidence-command",
      "devkit-no-such-evidence-bin-xyz",
    ],
    env,
    cap.io,
    { loadPlatform: spyPlatform(counts) },
  );
  assert.equal(code, 0, cap.err());
  assert.equal(counts.check, 0);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.steps[0]?.status, "done");
  assert.equal(rec.steps[0]?.evidence?.verdict, "skipped");
});

test("mark done after blocked ingests step_blocked_then_completed", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const blockCap = captureIo();
  const blockCode = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "off",
      "implement",
      "--mark",
      "blocked",
    ],
    env,
    blockCap.io,
  );
  assert.equal(blockCode, 0, blockCap.err());
  const doneCap = captureIo();
  const doneCode = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "off",
      "implement",
      "--mark",
      "done",
    ],
    env,
    doneCap.io,
  );
  assert.equal(doneCode, 0, doneCap.err());
  assert.equal(existsSync(ctx.paths.signalsFile), true);
  const text = readFileSync(ctx.paths.signalsFile, "utf8");
  assert.match(text, /step_blocked_then_completed/);
});
