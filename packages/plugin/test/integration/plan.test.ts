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
import { fileURLToPath } from "node:url";
import { createContext } from "@coredevkit/platform";
import { runPluginCli, type PluginCliIo } from "../../src/cli.js";
import { loadCoordinator } from "../../src/lib/coordinator/store.js";
import { planFilePaths } from "../../src/lib/plan/paths.js";
import { worktreeHash } from "../../src/lib/worktree.js";

const dirs: string[] = [];
const fakeCbmDir = fileURLToPath(
  new URL("../../../platform/test/fixtures/fake-cbm", import.meta.url),
);
const fakeCbmBin = join(fakeCbmDir, "codebase-memory-mcp");

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
  const dir = tmp("devkit-in-plan-repo-");
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
    PATH: [fakeCbmDir, dirname(process.execPath), "/usr/bin", "/bin"].join(
      delimiter,
    ),
    FAKE_CBM_STATE: join(tmp("fake-cbm-state-"), "state.json"),
  };
  delete env.DEVKIT_CONFIG;
  delete env.DEVKIT_PLAN;
  delete env.DEVKIT_VERIFICATION;
  delete env.DEVKIT_PATH;
  delete env.DEVKIT_CBM_BINARY;
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

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-IN-P-01 plan render and start-coordinator after fake init", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const initCap = captureIo();
  const initCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "init"],
    env,
    initCap.io,
  );
  assert.equal(initCode, 0, initCap.err());

  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(existsSync(ctx.paths.cbmProjectFile), true);
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    paths.intentPath,
    `${JSON.stringify(
      {
        version: 1,
        title: "Add writing-plans",
        summary: "Ship intent HTML and plan CLI.",
        goal: "Add writing-plans and intent HTML.",
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
            title: "Ship plan",
            complete: true,
            steps: [
              {
                id: "PS1",
                title: "Schema",
                detail: "Add zod.",
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
    `# Add writing-plans

Goal: Ship intent HTML.

## Steps

1. **S1: Add intent schema** — paths \`packages/plugin/src/lib/plan/intent.ts\`.

## Stack

none
`,
  );

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
  assert.equal(existsSync(paths.htmlPath), true);
  const html = readFileSync(paths.htmlPath, "utf8");
  assert.match(html, /Schema/);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.steps[0]?.id, "S1");
  assert.equal(rec.resume_step_id, "S1");
  const packet = JSON.parse(cap.out()) as { html_path?: string };
  assert.equal(packet.html_path, paths.htmlPath);
});
