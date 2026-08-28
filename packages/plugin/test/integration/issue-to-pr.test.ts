import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { createContext } from "@coredevkit/platform";
import { runPluginCli, type PluginCliIo } from "../../src/cli.js";
import { loadCoordinator } from "../../src/lib/coordinator/store.js";
import { sowFilePath } from "../../src/lib/issue/pipeline.js";
import { planFilePaths } from "../../src/lib/plan/paths.js";
import { worktreeHash } from "../../src/lib/worktree.js";

const dirs: string[] = [];
const SECRET = "SECRET_BODY_TOKEN";

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
  const dir = tmp("devkit-i2p-repo-");
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
  const remote = tmp("devkit-i2p-remote-");
  git(remote, ["init", "--bare"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
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
if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    number: 12,
    title: "Add file A",
    body: ${JSON.stringify(`${SECRET} do the work`)},
    labels: [{ name: "enhancement" }],
    url: "https://example.test/issues/12",
    comments: [{ body: "please also test" }],
  }) + "\\n");
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
  const dir = tmp("devkit-i2p-bin-");
  symlinkSync(whichBin("git"), join(dir, "git"));
  writeFakeGh(dir, logFile, countFile);
  return dir;
}

function makeGitBin(): string {
  const dir = tmp("devkit-i2p-gitbin-");
  symlinkSync(whichBin("git"), join(dir, "git"));
  return dir;
}

function ghMissingCount(err: string): number {
  return (err.match(/PR not opened because gh is missing/g) ?? []).length;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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

const PLAN_MD = `# Add file A

Goal: Close issue 12.

## Steps

1. **S1: Add file A** — paths \`a.txt\`.

## Stack

none
`;

function planIntent(agentPlan: string, stacked: boolean): string {
  return `${JSON.stringify(
    {
      version: 1,
      title: "Add file A",
      summary: "Close issue 12.",
      goal: stacked
        ? "Publish one stacked pull request from the issue."
        : "Publish one pull request from the issue.",
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
          title: "Ship issue",
          complete: true,
          steps: [
            {
              id: "PS1",
              title: "Add file",
              detail: "Write a.txt.",
              required: true,
            },
          ],
        },
      ],
      sequences: [],
      stack: stacked
        ? [
            {
              id: "A",
              title: "Item A",
              branch: "feat/a",
              base: "@default",
              step_ids: ["S1"],
              depends_on: [],
            },
          ]
        : [],
      risks: [],
    },
    null,
    2,
  )}\n`;
}

function writePlan(
  planDir: string,
  stacked = true,
): ReturnType<typeof planFilePaths> {
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(paths.intentPath, planIntent(paths.agentPlan, stacked));
  writeFileSync(paths.agentPlan, PLAN_MD);
  return paths;
}

function writeMapping(
  ctx: Awaited<ReturnType<typeof createContext>>,
): void {
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

function parsePacket(out: string): Record<string, unknown> {
  const text = out.trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function ghCalls(logFile: string): string[][] {
  const text = readFileSync(logFile, "utf8").trim();
  if (!text) {
    return [];
  }
  return text.split("\n").map((line) => JSON.parse(line) as string[]);
}

function issueViews(logFile: string): string[][] {
  return ghCalls(logFile).filter(
    (args) => args[0] === "issue" && args[1] === "view",
  );
}

function prCreates(logFile: string): string[][] {
  return ghCalls(logFile).filter(
    (args) => args[0] === "pr" && args[1] === "create",
  );
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-I2P-01 happy path mocks gh issue view and pr create; SoW stays in user-data", async () => {
  const logFile = join(tmp("devkit-i2p-gh-log-"), "gh.log");
  const countFile = join(tmp("devkit-i2p-gh-count-"), "n");
  writeFileSync(logFile, "");
  const env = isolatedEnv(tmp("devkit-data-"), makeBin(logFile, countFile));
  const repo = makeRepo();
  addOrigin(repo);
  const planDir = join(repo, "tracked-plan");
  writePlan(planDir);
  git(repo, ["add", "tracked-plan"]);
  git(repo, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "track plan",
  ]);
  git(repo, ["push", "origin", "main"]);
  const ctx = await createContext({ repoPath: repo, env });
  writeMapping(ctx);
  const wt = worktreeHash(ctx.repoPath);

  const cap1 = captureIo();
  const code1 = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "issue-to-pr",
      "--issue",
      "12",
      "--accept-plan",
      "--publish",
    ],
    env,
    cap1.io,
  );
  assert.equal(code1, 0, cap1.err());
  const packet1 = parsePacket(cap1.out());
  assert.equal(packet1.stack_phase, "checked_out");
  assert.equal(packet1.stack_branch, "feat/a");
  assert.equal(packet1.pipeline_phase, "implement");
  assert.ok(issueViews(logFile).length >= 1);
  assert.equal(prCreates(logFile).length, 0);

  const sow = sowFilePath(ctx.paths.progressDir, wt.worktree_hash);
  assert.equal(existsSync(sow), true);
  const sowText = readFileSync(sow, "utf8");
  assert.match(sowText, new RegExp(SECRET));
  assert.equal(existsSync(join(planDir, "sow.md")), false);
  assert.equal(existsSync(join(repo, "sow.md")), false);
  const planFiles = readdirSync(planDir);
  for (const name of planFiles) {
    const text = readFileSync(join(planDir, name), "utf8");
    assert.equal(text.includes(SECRET), false, name);
  }
  if (process.platform !== "win32") {
    assert.equal(statSync(sow).mode & 0o777, 0o600);
  }
  assert.match(cap1.err(), /Issue 12: Add file A/);
  assert.match(cap1.err(), /enhancement/);
  assert.equal(cap1.err().includes(SECRET), false);
  assert.equal(cap1.err().includes("please also test"), false);
  const logPath = join(ctx.paths.logsDir, "plugin.jsonl");
  assert.equal(existsSync(logPath), true);
  const logText = readFileSync(logPath, "utf8");
  assert.equal(logText.includes(SECRET), false);
  assert.match(logText, /plugin.issue_to_pr.start/);
  assert.match(logText, /"issue":12/);

  const rec1 = await loadCoordinator(ctx);
  assert.equal(rec1.source, "issue-to-pr");
  assert.equal(rec1.issue?.number, 12);
  assert.equal(rec1.stack.prs[0]?.phase, "checked_out");
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/a");

  writeFileSync(join(repo, "a.txt"), "a\n");
  const capMark = captureIo();
  const markCode = await runPluginCli(
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
    capMark.io,
  );
  assert.equal(markCode, 0, capMark.err());

  const cap2 = captureIo();
  const code2 = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "issue-to-pr",
      "--publish",
    ],
    env,
    cap2.io,
  );
  assert.equal(code2, 0, cap2.err());
  const packet2 = parsePacket(cap2.out());
  assert.equal(packet2.stack_phase, "pr_created");
  const rec2 = await loadCoordinator(ctx);
  assert.equal(rec2.stack.prs[0]?.phase, "pr_created");
  assert.equal(rec2.stack.prs[0]?.pr_state, "created");
  assert.equal(rec2.pipeline_phase, "complete");
  const creates = prCreates(logFile);
  assert.equal(creates.length, 1);
  const head = creates[0]?.indexOf("--head") ?? -1;
  assert.equal(creates[0]?.[head + 1], "feat/a");
});

test("T-I2P-02 missing --accept-plan keeps pipeline refine", async () => {
  const logFile = join(tmp("devkit-i2p-gh-log-"), "gh.log");
  const countFile = join(tmp("devkit-i2p-gh-count-"), "n");
  writeFileSync(logFile, "");
  const env = isolatedEnv(tmp("devkit-data-"), makeBin(logFile, countFile));
  const repo = makeRepo();
  const planDir = join(repo, "tracked-plan");
  writePlan(planDir);
  git(repo, ["add", "tracked-plan"]);
  git(repo, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "track plan",
  ]);
  const ctx = await createContext({ repoPath: repo, env });
  writeMapping(ctx);

  const capStart = captureIo();
  const startCode = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "plan",
      "--start-coordinator",
    ],
    env,
    capStart.io,
  );
  assert.equal(startCode, 0, capStart.err());
  const before = await loadCoordinator(ctx);
  assert.equal(before.source, "plan");
  assert.equal(before.pipeline_phase, null);

  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "issue-to-pr",
      "--issue",
      "12",
      "--publish",
    ],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = parsePacket(cap.out());
  assert.equal(packet.pipeline_phase, "refine");
  assert.equal(packet.skill, "writing-plans");
  assert.match(String(packet.hint), /--accept-plan/);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.pipeline_phase, "refine");
  assert.equal(rec.source, "plan");
  assert.equal(rec.stack.prs[0]?.phase, "none");
  assert.equal(prCreates(logFile).length, 0);
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");

  const sow = sowFilePath(
    ctx.paths.progressDir,
    worktreeHash(ctx.repoPath).worktree_hash,
  );
  assert.equal(existsSync(sow), true);
  assert.equal(existsSync(join(planDir, "sow.md")), false);
});

async function acceptSinglePr(
  repo: string,
  env: NodeJS.ProcessEnv,
  planDir: string,
): Promise<void> {
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "--verification",
      "off",
      "issue-to-pr",
      "--issue",
      "12",
      "--accept-plan",
    ],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  writeFileSync(join(repo, "a.txt"), "a\n");
  const mark = captureIo();
  const markCode = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "--verification",
      "off",
      "implement",
      "--mark",
      "done",
    ],
    env,
    mark.io,
  );
  assert.equal(markCode, 0, mark.err());
}

test("single-PR path marks done then publishes one gh pr create", async () => {
  const logFile = join(tmp("devkit-i2p-gh-log-"), "gh.log");
  const countFile = join(tmp("devkit-i2p-gh-count-"), "n");
  writeFileSync(logFile, "");
  const env = isolatedEnv(tmp("devkit-data-"), makeBin(logFile, countFile));
  const repo = makeRepo();
  addOrigin(repo);
  const ctx = await createContext({ repoPath: repo, env });
  writeMapping(ctx);
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  writePlan(planDir, false);
  await acceptSinglePr(repo, env, planDir);

  const recBefore = await loadCoordinator(ctx);
  assert.equal(recBefore.stack.enabled, false);
  assert.equal(recBefore.source, "issue-to-pr");
  assert.equal(recBefore.steps[0]?.status, "done");

  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "--verification",
      "off",
      "issue-to-pr",
      "--publish",
    ],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const creates = prCreates(logFile);
  assert.equal(creates.length, 1);
  assert.equal(flagValue(creates[0] ?? [], "--base"), "main");
  assert.equal(flagValue(creates[0] ?? [], "--head"), "issue-12");
  assert.equal(flagValue(creates[0] ?? [], "--title"), "Add file A");
  assert.equal(flagValue(creates[0] ?? [], "--body"), "Closes #12.");
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.pipeline_phase, "complete");
  assert.equal(rec.stack.enabled, false);
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "issue-12");
});

test("single-PR gh missing keeps local issue branch and skips pr create", async () => {
  const logFile = join(tmp("devkit-i2p-gh-log-"), "gh.log");
  const countFile = join(tmp("devkit-i2p-gh-count-"), "n");
  writeFileSync(logFile, "");
  const dataRoot = tmp("devkit-data-");
  const envGh = isolatedEnv(dataRoot, makeBin(logFile, countFile));
  const repo = makeRepo();
  addOrigin(repo);
  const ctx = await createContext({ repoPath: repo, env: envGh });
  writeMapping(ctx);
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  writePlan(planDir, false);
  await acceptSinglePr(repo, envGh, planDir);

  const envNoGh = isolatedEnv(dataRoot, makeGitBin());
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--plan",
      planDir,
      "--verification",
      "off",
      "issue-to-pr",
      "--publish",
    ],
    envNoGh,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  assert.equal(ghMissingCount(cap.err()), 1);
  const packet = parsePacket(cap.out());
  assert.notEqual(packet.hint, "PR not opened because gh is missing.");
  assert.equal(prCreates(logFile).length, 0);
  git(repo, ["rev-parse", "--verify", "issue-12"]);
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "issue-12");
});
