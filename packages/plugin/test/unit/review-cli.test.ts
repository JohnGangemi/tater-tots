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
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext } from "@coredevkit/platform";
import {
  parsePluginArgv,
  runPluginCli,
  type PluginCliIo,
} from "../../src/cli.js";
import { loadCoordinator } from "../../src/lib/coordinator/store.js";
import { planFilePaths } from "../../src/lib/plan/paths.js";
import { loadPlatform } from "../../src/lib/platform-guard.js";
import { collectDiffPaths } from "../../src/lib/review/command.js";
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
  const dir = tmp("devkit-rev-repo-");
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

async function writeMapping(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const ctx = await createContext({ repoPath: repo, env });
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

function emptyImpact() {
  return {
    callers: [],
    dependents: [],
    truncated: false,
    graph: "ready" as const,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePluginArgv stores review --scope", () => {
  const parsed = parsePluginArgv([
    "node",
    "devkit",
    "review",
    "--scope",
    "src/a.ts",
  ]);
  assert.equal(parsed.pluginCommand, "review");
  assert.equal(parsed.scope, "src/a.ts");
});

test("review command source does not walk the tree", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/lib/review/command.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(src.includes("readdir"), false);
  assert.equal(src.includes("glob"), false);
});

test("collectDiffPaths unions unstaged and cached names and caps 20", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "a.ts"]);
  git(repo, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "a",
  ]);
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git(repo, ["add", "b.ts"]);
  const names = collectDiffPaths(repo);
  assert.ok(names.includes("a.ts"));
  assert.ok(names.includes("b.ts"));
  assert.deepEqual(collectDiffPaths(repo, "src/only.ts"), ["src/only.ts"]);

  for (let i = 0; i < 21; i++) {
    writeFileSync(join(repo, `f${i}.ts`), `export const f${i} = 1;\n`);
  }
  git(repo, ["add", "."]);
  const capped = collectDiffPaths(repo);
  assert.equal(capped.length, 20);
});

test("review calls graphImpact per diff path and dispatches reviewer", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await writeMapping(repo, env);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "a.ts"]);
  git(repo, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "a",
  ]);
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git(repo, ["add", "b.ts"]);
  mkdirSync(join(repo, ".devkit"), { recursive: true });
  writeFileSync(
    join(repo, ".devkit", "config.yaml"),
    "subagents:\n  reviewer: my-reviewer\n",
  );
  const impacts: { path?: string }[] = [];
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "review"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphImpact") {
              return async (_ctx: unknown, q: { path?: string }) => {
                impacts.push(q);
                return emptyImpact();
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 0, cap.err());
  assert.deepEqual(
    impacts.map((i) => i.path).sort(),
    ["a.ts", "b.ts"],
  );
  const packet = JSON.parse(cap.out()) as {
    command?: string;
    dispatch?: { role?: string; agent?: string } | null;
    packet?: { role?: string; allowed_paths?: string[] };
  };
  assert.equal(packet.command, "review");
  assert.equal(packet.dispatch?.role, "reviewer");
  assert.equal(packet.dispatch?.agent, "my-reviewer");
  assert.equal(packet.packet?.role, "reviewer");
  assert.ok(packet.packet?.allowed_paths?.includes("a.ts"));
  assert.ok(packet.packet?.allowed_paths?.includes("b.ts"));
});

test("review --scope limits to one path", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await writeMapping(repo, env);
  writeFileSync(join(repo, "a.ts"), "a\n");
  writeFileSync(join(repo, "b.ts"), "b\n");
  git(repo, ["add", "."]);
  const impacts: { path?: string }[] = [];
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "review",
      "--scope",
      "a.ts",
    ],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphImpact") {
              return async (_ctx: unknown, q: { path?: string }) => {
                impacts.push(q);
                return emptyImpact();
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 0, cap.err());
  assert.deepEqual(impacts, [{ path: "a.ts" }]);
});

test("review does not mark coordinator done", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await writeMapping(repo, env);
  const ctx = await createContext({ repoPath: repo, env });
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    paths.intentPath,
    `${JSON.stringify({
      version: 1,
      title: "t",
      summary: "s",
      goal: "g",
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
          title: "Ship",
          complete: true,
          steps: [
            { id: "PS1", title: "One", detail: "d", required: true },
          ],
        },
      ],
      sequences: [],
      stack: [],
      risks: [],
    })}\n`,
  );
  writeFileSync(
    paths.agentPlan,
    `# t

## Steps

1. **S1: One** — paths \`a.ts\`.

## Stack

none
`,
  );
  const startCap = captureIo();
  const startCode = await runPluginCli(
    ["node", "devkit", "--path", repo, "plan", "--start-coordinator"],
    env,
    startCap.io,
  );
  assert.equal(startCode, 0, startCap.err());
  const before = await loadCoordinator(ctx);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "review", "--scope", "a.ts"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphImpact") {
              return async () => emptyImpact();
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 0, cap.err());
  const after = await loadCoordinator(ctx);
  assert.equal(after.steps[0]?.status, before.steps[0]?.status);
  assert.notEqual(after.steps[0]?.status, "done");
});

test("review without graph mapping exits 3", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  let impacts = 0;
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "review", "--scope", "a.ts"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphImpact") {
              return async () => {
                impacts += 1;
                throw new Error("graphImpact must not run");
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 3, cap.err());
  assert.equal(impacts, 0);
  assert.match(cap.err(), /run devkit init/);
});
