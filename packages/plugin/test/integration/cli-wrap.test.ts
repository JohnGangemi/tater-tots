import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, playbookRecord } from "@coredevkit/platform";
import { HELP, runPluginCli, type PluginCliIo } from "../../src/cli.js";
import { loadPlatform } from "../../src/lib/platform-guard.js";

const dirs: string[] = [];
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

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
  const dir = tmp("devkit-cli-repo-");
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
  delete env.DEVKIT_PLAYBOOK_RESET;
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

test("T-IN-P-08 plugin CLI playbook stats reaches platform", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(
    (
      await playbookRecord(ctx, {
        raw_command: "pnpm test",
        tool_name: "Bash",
        cwd: repo,
        exit_code: 0,
        duration_ms: 10,
      })
    ).result,
    "stored",
  );
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "playbook", "stats"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  const stats = JSON.parse(cap.out()) as { entries?: number };
  assert.ok((stats.entries ?? 0) >= 1);
});

test("T-IN-P-08b fetch-cbm and --mode reach platform runCli", async () => {
  const seen: string[][] = [];
  const env = isolatedEnv(tmp("devkit-data-"));
  const cap = captureIo();
  const code1 = await runPluginCli(
    ["node", "devkit", "--fetch-cbm", "init"],
    env,
    cap.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "runCli") {
              return async (argv: string[]) => {
                seen.push(argv);
                return 0;
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code1, 0, cap.err());
  assert.equal(seen.length, 1);
  assert.ok(seen[0]?.includes("--fetch-cbm"));
  assert.ok(seen[0]?.includes("init"));

  const cap2 = captureIo();
  const code2 = await runPluginCli(
    ["node", "devkit", "init", "--mode", "fast"],
    env,
    cap2.io,
    {
      loadPlatform: async () => {
        const real = await loadPlatform();
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === "runCli") {
              return async (argv: string[]) => {
                seen.push(argv);
                return 0;
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      },
    },
  );
  assert.equal(code2, 0, cap2.err());
  assert.equal(seen.length, 2);
  assert.ok(seen[1]?.includes("init"));
  assert.ok(seen[1]?.includes("--mode"));
  assert.ok(seen[1]?.includes("fast"));
});

test("T-IN-P-11 workspace bin is the plugin wrapper and help lists plan/implement", async () => {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as {
    bin?: { devkit?: string };
  };
  assert.equal(rootPkg.bin?.devkit, "packages/plugin/dist/cli.js");
  const pluginPkg = JSON.parse(
    readFileSync(join(repoRoot, "packages", "plugin", "package.json"), "utf8"),
  ) as { bin?: { devkit?: string } };
  assert.equal(pluginPkg.bin?.devkit, "dist/cli.js");

  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--help"],
    isolatedEnv(tmp("devkit-data-")),
    cap.io,
  );
  assert.equal(code, 0);
  const text = cap.out();
  assert.match(text, /\bplan\b/);
  assert.match(text, /\bimplement\b/);
  assert.match(text, /\binit\b/);
  assert.match(text, /\bplaybook\b/);
  assert.match(text, /evidence-check/);
  assert.match(text, /--fetch-cbm/);
  assert.match(text, /--path/);
  assert.equal(text, HELP);

  const distCli = join(repoRoot, "packages", "plugin", "dist", "cli.js");
  const help = execFileSync(process.execPath, [distCli, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: isolatedEnv(tmp("devkit-data-")),
  });
  assert.match(help, /\bplan\b/);
  assert.match(help, /\bimplement\b/);

  const pnpmEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: tmp("devkit-data-"),
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
  };
  const pnpmHelp = execFileSync("pnpm", ["exec", "devkit", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: pnpmEnv,
  });
  assert.match(pnpmHelp, /\bplan\b/);
  assert.match(pnpmHelp, /\bimplement\b/);
});
