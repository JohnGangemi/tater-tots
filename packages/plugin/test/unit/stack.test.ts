import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
import type {
  CoordinatorRecord,
  StackPr,
} from "../../src/lib/coordinator/types.js";
import { resolveStackBase } from "../../src/lib/stack/create.js";
import type { StackItem } from "../../src/lib/plan/intent.js";
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

function makeRepo(identity = true): string {
  const dir = tmp("devkit-st-repo-");
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
  if (identity) {
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "user.email", "t@t"]);
  }
  return dir;
}

function addOrigin(repo: string): string {
  const remote = tmp("devkit-st-remote-");
  git(remote, ["init", "--bare"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  return remote;
}

function makeGitBin(): string {
  const dir = tmp("devkit-st-bin-");
  symlinkSync(whichBin("git"), join(dir, "git"));
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
      components: [
        { id: "c1", name: "files", path: ".", role: "lib" },
      ],
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

function samplePr(
  stack_id: string,
  branch: string,
  base: string,
): StackPr {
  return {
    stack_id,
    branch,
    base,
    pr_number: null,
    pr_url: null,
    pr_state: "none",
    phase: "none",
    commit_sha: null,
    allowed_paths: [],
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePluginArgv stores stack publish", () => {
  const parsed = parsePluginArgv([
    "node",
    "devkit",
    "stack",
    "publish",
  ]);
  assert.equal(parsed.pluginCommand, "stack");
  assert.deepEqual(parsed.pluginRest, ["publish"]);
});

test("devkit stack without publish is usage", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack"],
    env,
    cap.io,
  );
  assert.equal(code, 1, cap.err());
  assert.match(cap.err(), /usage: devkit stack publish/);
});

test("resolveStackBase: depends_on wins over base", () => {
  const items: StackItem[] = [
    {
      id: "A",
      title: "A",
      branch: "feat/a",
      base: "@default",
      step_ids: ["S1"],
      depends_on: [],
    },
    {
      id: "B",
      title: "B",
      branch: "feat/b",
      base: "wrong-base",
      step_ids: ["S2"],
      depends_on: ["A"],
    },
  ];
  const record = {
    stack: {
      enabled: true,
      default_branch: "main",
      prs: [
        samplePr("A", "feat/a", "@default"),
        samplePr("B", "feat/b", "wrong-base"),
      ],
    },
  } as CoordinatorRecord;
  const b = record.stack.prs[1];
  assert.ok(b);
  assert.equal(resolveStackBase(record, b, items), "feat/a");
  const a = record.stack.prs[0];
  assert.ok(a);
  assert.equal(resolveStackBase(record, a, items), "main");
});

test("T-ST-01 stack publish with dirty worktree exits 1 and skips checkout -B", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  await startStacked(repo, env);
  writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  const before = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    cap.io,
  );
  assert.equal(code, 1, cap.err());
  assert.match(cap.err(), /worktree is dirty/);
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), before);
  assert.notEqual(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/a");
});

test("T-ST-02 missing git identity exits 1", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo(false);
  const ctx = await startStacked(repo, env);
  const rec = await loadCoordinator(ctx);
  const a = rec.stack.prs[0];
  assert.ok(a);
  a.phase = "checked_out";
  rec.steps[0]!.status = "done";
  rec.steps[0]!.stack_id = "A";
  await saveCoordinator(ctx, rec);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    cap.io,
  );
  assert.equal(code, 1, cap.err());
  assert.match(cap.err(), /set git user.name and user.email/);
});

test("T-ST-03 resume phase committed pushes and does not commit again", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  addOrigin(repo);
  const ctx = await startStacked(repo, env);
  const first = captureIo();
  const firstCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    first.io,
  );
  assert.equal(firstCode, 0, first.err());
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "--", "a.txt"]);
  git(repo, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "A",
  ]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  const rec = await loadCoordinator(ctx);
  rec.steps[0]!.status = "done";
  rec.steps[0]!.stack_id = "A";
  rec.stack.prs[0]!.phase = "committed";
  rec.stack.prs[0]!.commit_sha = sha;
  await saveCoordinator(ctx, rec);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  assert.equal(git(repo, ["rev-parse", "HEAD"]), sha);
  const remote = git(repo, ["ls-remote", "--heads", "origin", "feat/a"]);
  assert.match(remote, /feat\/a/);
});

test("T-ST-04 checked_out with a pending step exits 1 and does not commit", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  await startStacked(repo, env);
  const first = captureIo();
  const firstCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    first.io,
  );
  assert.equal(firstCode, 0, first.err());
  const sha = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    cap.io,
  );
  assert.equal(code, 1, cap.err());
  assert.match(cap.err(), /finish stack item A steps first/);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), sha);
});

test("T-ST-05 stacked coordinator phase none, implement exits 1", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  const ctx = await startStacked(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "implement"],
    env,
    cap.io,
  );
  assert.equal(code, 1, cap.err());
  assert.match(cap.err(), /run devkit stack publish/);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.stack.prs[0]?.phase, "none");
  assert.equal(rec.steps[0]?.status, "pending");
  assert.equal(rec.steps[1]?.status, "pending");
});

test("T-ST-06 mark done last step of item A does not resume a B id", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  const ctx = await startStacked(repo, env);
  const first = captureIo();
  const firstCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    first.io,
  );
  assert.equal(firstCode, 0, first.err());
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
    ],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as {
    resume_step_id?: string | null;
    hint?: string;
  };
  assert.equal(packet.resume_step_id, null);
  assert.match(packet.hint ?? cap.err(), /run devkit stack publish/);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.resume_step_id, null);
  assert.equal(rec.steps[0]?.status, "done");
  assert.equal(rec.steps[1]?.status, "pending");
  assert.notEqual(rec.resume_step_id, "S2");
});

test("T-ST-07 two stack items seed none; implement exits 1; merge keeps checked_out", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  const ctx = await startStacked(repo, env);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.stack.prs.length, 2);
  assert.equal(rec.stack.prs[0]?.phase, "none");
  assert.equal(rec.stack.prs[1]?.phase, "none");
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "implement"],
    env,
    cap.io,
  );
  assert.equal(code, 1, cap.err());
  assert.match(cap.err(), /run devkit stack publish/);

  rec.stack.prs[0]!.phase = "checked_out";
  await saveCoordinator(ctx, rec);
  const merge = captureIo();
  const mergeCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "plan", "--start-coordinator"],
    env,
    merge.io,
  );
  assert.equal(mergeCode, 0, merge.err());
  const after = await loadCoordinator(ctx);
  assert.equal(after.stack.prs[0]?.phase, "checked_out");
  assert.equal(after.stack.prs[1]?.phase, "none");
});

test("T-ST-08 gh missing after pushed exits 0 and skips pr create", async () => {
  const env = isolatedEnv(tmp("devkit-data-"), makeGitBin());
  const repo = makeRepo();
  const ctx = await startStacked(repo, env);
  git(repo, ["checkout", "-B", "feat/a"]);
  const rec = await loadCoordinator(ctx);
  rec.steps[0]!.status = "done";
  rec.stack.prs[0]!.phase = "pushed";
  rec.stack.prs[0]!.pr_state = "none";
  await saveCoordinator(ctx, rec);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "stack", "publish"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  assert.match(cap.err(), /PR not opened because gh is missing/);
  const after = await loadCoordinator(ctx);
  assert.equal(after.stack.prs[0]?.phase, "pushed");
  assert.equal(after.stack.prs[0]?.pr_state, "none");
  git(repo, ["rev-parse", "--verify", "feat/a"]);
});

