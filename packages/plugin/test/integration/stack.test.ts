import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

function whichBin(name: string): string {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  const line = (r.stdout || "").trim().split(/\r?\n/)[0];
  if (!line || r.status !== 0) {
    throw new Error(`${name} is missing`);
  }
  return line;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

function makeRepo(): string {
  const dir = tmp("devkit-in-st-repo-");
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
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@t"]);
  return dir;
}

function addOrigin(repo: string): string {
  const remote = tmp("devkit-in-st-remote-");
  git(remote, ["init", "--bare"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  return remote;
}

function writeFakeGh(bin: string, logFile: string, countFile: string): void {
  const path = join(bin, "gh");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  process.stdout.write("gh fake 0\\n");
  process.exit(0);
}
if (args[0] === "repo") {
  process.stdout.write(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const cf = ${JSON.stringify(countFile)};
  let n = 1;
  if (fs.existsSync(cf)) n = Number(fs.readFileSync(cf, "utf8")) + 1;
  fs.writeFileSync(cf, String(n));
  process.stdout.write("https://example.test/pr/" + n + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh argv\\n");
process.exit(1);
`,
  );
  chmodSync(path, 0o755);
}

function makeBin(logFile: string, countFile: string): string {
  const dir = tmp("devkit-in-st-bin-");
  symlinkSync(whichBin("git"), join(dir, "git"));
  writeFakeGh(dir, logFile, countFile);
  return dir;
}

function isolatedEnv(
  dataRoot: string,
  binDir: string,
): NodeJS.ProcessEnv {
  const home = tmp("devkit-home-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
    HOME: home,
    USERPROFILE: home,
    PATH: [binDir, dirname(process.execPath)].join(delimiter),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  delete env.DEVKIT_CONFIG;
  delete env.DEVKIT_PLAN;
  delete env.DEVKIT_VERIFICATION;
  delete env.DEVKIT_PATH;
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
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

const PLAN_MD = `# Add stack

Goal: Two stacked items.

## Steps

1. **S1: Add file A** — paths \`a.txt\`.
2. **S2: Add file B** — paths \`b.txt\`.

## Stack

none
`;

function stackedIntent(agentPlan: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      title: "Add stack",
      summary: "Two stacked items.",
      goal: "Publish two stacked pull requests.",
      agent_plan: agentPlan,
      theme_default: "system",
      non_goals: [],
      constraints: [],
      assumptions: [],
      open_questions: [],
      components: [{ id: "c1", name: "files", path: ".", role: "lib" }],
      processes: [
        {
          id: "p1",
          title: "Ship stack",
          complete: true,
          steps: [
            {
              id: "PS1",
              title: "Stack",
              detail: "Two items.",
              required: true,
            },
          ],
        },
      ],
      sequences: [],
      stack: [
        {
          id: "A",
          title: "Item A",
          branch: "feat/a",
          base: "@default",
          step_ids: ["S1"],
          depends_on: [],
        },
        {
          id: "B",
          title: "Item B",
          branch: "feat/b",
          base: "wrong-base",
          step_ids: ["S2"],
          depends_on: ["A"],
        },
      ],
      risks: [],
    },
    null,
    2,
  )}\n`;
}

async function startStacked(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof createContext>>> {
  const ctx = await createContext({ repoPath: repo, env });
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(paths.intentPath, stackedIntent(paths.agentPlan));
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

async function publish(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; packet: Record<string, unknown>; err: string }> {
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    cap.io,
  );
  let packet: Record<string, unknown> = {};
  const out = cap.out().trim();
  if (out) {
    packet = JSON.parse(out) as Record<string, unknown>;
  }
  return { code, packet, err: cap.err() };
}

async function markDone(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const cap = captureIo();
  return runPluginCli(
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
    cap.io,
  );
}

function prCreates(logFile: string): string[][] {
  const text = readFileSync(logFile, "utf8").trim();
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "pr" && args[1] === "create");
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-IN-P-07 two implement/publish cycles; second PR base is A branch", async () => {
  const logFile = join(tmp("devkit-gh-log-"), "gh.log");
  const countFile = join(tmp("devkit-gh-count-"), "n");
  writeFileSync(logFile, "");
  const env = isolatedEnv(tmp("devkit-data-"), makeBin(logFile, countFile));
  const repo = makeRepo();
  addOrigin(repo);
  const ctx = await startStacked(repo, env);

  const p1 = await publish(repo, env);
  assert.equal(p1.code, 0, p1.err);
  assert.equal(p1.packet.stack_phase, "checked_out");
  assert.equal(p1.packet.stack_branch, "feat/a");
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/a");
  assert.equal(prCreates(logFile).length, 0);

  writeFileSync(join(repo, "a.txt"), "a\n");
  assert.equal(await markDone(repo, env), 0);
  const afterA = await loadCoordinator(ctx);
  assert.equal(afterA.steps[0]?.status, "done");
  assert.equal(afterA.steps[1]?.status, "pending");
  assert.equal(afterA.resume_step_id, null);

  const p2 = await publish(repo, env);
  assert.equal(p2.code, 0, p2.err);
  assert.equal(p2.packet.stack_phase, "pr_created");
  assert.equal(p2.packet.stack_branch, "feat/a");
  const recA = await loadCoordinator(ctx);
  assert.equal(recA.stack.prs[0]?.phase, "pr_created");
  assert.equal(recA.stack.prs[0]?.pr_state, "created");
  assert.equal(recA.stack.prs[1]?.phase, "none");
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/a");
  const createsAfterA = prCreates(logFile);
  assert.equal(createsAfterA.length, 1);
  assert.equal(flagValue(createsAfterA[0] ?? [], "--base"), "main");
  assert.equal(flagValue(createsAfterA[0] ?? [], "--head"), "feat/a");

  const p3 = await publish(repo, env);
  assert.equal(p3.code, 0, p3.err);
  assert.equal(p3.packet.stack_phase, "checked_out");
  assert.equal(p3.packet.stack_branch, "feat/b");
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/b");
  assert.equal(prCreates(logFile).length, 1);

  writeFileSync(join(repo, "b.txt"), "b\n");
  assert.equal(await markDone(repo, env), 0);
  const afterB = await loadCoordinator(ctx);
  assert.equal(afterB.steps[1]?.status, "done");

  const p4 = await publish(repo, env);
  assert.equal(p4.code, 0, p4.err);
  assert.equal(p4.packet.stack_phase, "pr_created");
  assert.equal(p4.packet.stack_branch, "feat/b");
  const recB = await loadCoordinator(ctx);
  assert.equal(recB.stack.prs[0]?.phase, "pr_created");
  assert.equal(recB.stack.prs[1]?.phase, "pr_created");
  const creates = prCreates(logFile);
  assert.equal(creates.length, 2);
  assert.equal(flagValue(creates[1] ?? [], "--base"), "feat/a");
  assert.equal(flagValue(creates[1] ?? [], "--head"), "feat/b");
  assert.notEqual(flagValue(creates[1] ?? [], "--base"), "wrong-base");
});
