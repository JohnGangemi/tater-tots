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
import { loadPlatform } from "../../src/lib/platform-guard.js";

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
  const dir = tmp("devkit-dbg-repo-");
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

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePluginArgv stores debug --query", () => {
  const parsed = parsePluginArgv([
    "node",
    "devkit",
    "debug",
    "--query",
    "TypeError fooBar",
  ]);
  assert.equal(parsed.pluginCommand, "debug");
  assert.equal(parsed.query, "TypeError fooBar");
  const eq = parsePluginArgv(["node", "devkit", "debug", "--query=boom"]);
  assert.equal(eq.query, "boom");
});

test("debug command source does not walk the tree", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/lib/debug/command.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(src.includes("readdir"), false);
  assert.equal(src.includes("glob"), false);
});

test("debug without graph mapping exits 3 and does not call graphSearch", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  let searches = 0;
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "debug", "--query", "TypeError"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphSearch") {
              return async () => {
                searches += 1;
                throw new Error("graphSearch must not run");
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 3, cap.err());
  assert.equal(searches, 0);
  assert.match(cap.err(), /run devkit init/);
});

test("debug packet uses graphSearch and explorer then coder", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await writeMapping(repo, env);
  mkdirSync(join(repo, ".devkit"), { recursive: true });
  writeFileSync(
    join(repo, ".devkit", "config.yaml"),
    "subagents:\n  explorer: my-explorer\n  coder: my-coder\n",
  );
  const queries: unknown[] = [];
  const cap = captureIo();
  const code = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "debug",
      "--query",
      "TypeError fooBar",
    ],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphSearch") {
              return async (
                _ctx: unknown,
                q: { query: string },
              ) => {
                queries.push(q);
                return {
                  hits: [
                    {
                      name: "fooBar",
                      label: "Function",
                      path: "src/foo.ts",
                      line: 1,
                      qn: "fooBar",
                    },
                  ],
                  truncated: false,
                  graph: "ready",
                };
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 0, cap.err());
  assert.deepEqual(queries, [{ query: "TypeError fooBar" }]);
  const packet = JSON.parse(cap.out()) as {
    command?: string;
    skill?: string;
    dispatch?: { role?: string; agent?: string } | null;
    packet?: {
      role?: string;
      agent?: string;
      allowed_paths?: string[];
      constraints?: string[];
    };
  };
  assert.equal(packet.command, "debug");
  assert.equal(packet.skill, "debug");
  assert.equal(packet.dispatch?.role, "explorer");
  assert.equal(packet.dispatch?.agent, "my-explorer");
  assert.equal(packet.packet?.role, "explorer");
  assert.equal(packet.packet?.agent, "my-explorer");
  assert.deepEqual(packet.packet?.allowed_paths, ["src/foo.ts"]);
  assert.ok(packet.packet?.constraints?.some((c) => c.includes("my-coder")));
  assert.match(cap.err(), /explorer then my-coder/);
});

test("debug zero graph hits still prints a packet", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await writeMapping(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "debug", "--query", "noHitsHere"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphSearch") {
              return async () => ({
                hits: [],
                truncated: false,
                graph: "ready",
              });
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 0, cap.err());
  const packet = JSON.parse(cap.out()) as {
    packet?: { allowed_paths?: string[] };
  };
  assert.deepEqual(packet.packet?.allowed_paths, []);
});

test("debug graph_unavailable from graphSearch exits 3", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  await writeMapping(repo, env);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "debug", "--query", "x"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "graphSearch") {
              return async () => {
                throw new real.PlatformError(
                  "graph_unavailable",
                  "Graph mapping missing",
                  "run devkit init",
                );
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code, 3, cap.err());
  assert.match(cap.err(), /run devkit init/);
});
