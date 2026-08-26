import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { loadConfig, SHIPPED_DEFAULTS } from "../../src/lib/config.js";
import { createContext } from "../../src/lib/context.js";
import { PlatformError } from "../../src/lib/errors.js";
import { parseArgv, runCli } from "../../src/cli.js";
import { execFileSync } from "node:child_process";

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
  const dir = tmp("devkit-cfg-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
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
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  };
  delete env.DEVKIT_CBM_BINARY;
  delete env.CODEX_HOME;
  return env;
}

function silentIo(chunks?: string[]) {
  return {
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    stderr: {
      write: (s: string) => {
        chunks?.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-CFG-02 Shipped tuning.auto_accept is false", () => {
  assert.equal(SHIPPED_DEFAULTS.tuning.auto_accept, false);
  const dataRoot = tmp("devkit-data-");
  const cfg = loadConfig({ env: isolatedEnv(dataRoot) });
  assert.equal(cfg.tuning.auto_accept, false);
  assert.equal(cfg.verification.level, "light");
  assert.equal(cfg.resolved_level, "light");
});

test("T-CFG-01 CLI --verification full overrides config light", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, ".devkit"), { recursive: true });
  writeFileSync(join(repo, ".devkit", "config.yaml"), "verification:\n  level: light\n");
  const env = isolatedEnv(dataRoot);
  const argv = ["node", "devkit", "--path", repo, "--verification", "full", "init"];
  const args = parseArgv(argv);
  assert.equal(args.verification, "full");
  const ctx = await createContext({
    repoPath: args.path,
    configFile: args.config,
    verification: args.verification,
    env,
  });
  assert.equal(ctx.config.verification.level, "full");
  assert.equal(ctx.config.resolved_level, "full");

  const code = await runCli(argv, env, silentIo());
  assert.equal(code, 3);
});

test("env DEVKIT_VERIFICATION overrides file and CLI wins over env", () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, ".devkit"), { recursive: true });
  writeFileSync(join(repo, ".devkit", "config.yaml"), "verification:\n  level: light\n");
  const envOnly = loadConfig({
    repoPath: repo,
    env: { ...isolatedEnv(dataRoot), DEVKIT_VERIFICATION: "full" },
  });
  assert.equal(envOnly.resolved_level, "full");
  const cliWins = loadConfig({
    repoPath: repo,
    verification: "off",
    env: { ...isolatedEnv(dataRoot), DEVKIT_VERIFICATION: "full" },
  });
  assert.equal(cliWins.resolved_level, "off");
});

test("invalid verification.level fails load", () => {
  const dataRoot = tmp("devkit-data-");
  const file = join(tmp("devkit-cfg-"), "bad.yaml");
  writeFileSync(file, "verification:\n  level: nope\n");
  assert.throws(
    () => loadConfig({ configFile: file, env: isolatedEnv(dataRoot) }),
    (err: unknown) => err instanceof PlatformError && err.code === "config",
  );
});

test("playbook.frequency unknown value does not fail load", () => {
  const dataRoot = tmp("devkit-data-");
  const file = join(tmp("devkit-cfg-"), "freq.yaml");
  writeFileSync(file, "playbook:\n  frequency: every-keystroke\n");
  const cfg = loadConfig({
    configFile: file,
    env: isolatedEnv(dataRoot),
  });
  assert.equal(cfg.playbook.frequency, "every-keystroke");
  assert.equal(cfg.playbook.filter, "medium");
});

test("skip_skills arrays replace", () => {
  const dataRoot = tmp("devkit-data-");
  const project = makeRepo();
  mkdirSync(join(project, ".devkit"), { recursive: true });
  writeFileSync(join(project, ".devkit", "config.yaml"), "platform:\n  skip_skills: [a, b]\n");
  const extra = join(tmp("devkit-cfg-"), "extra.yaml");
  writeFileSync(extra, "platform:\n  skip_skills: [c]\n");
  const cfg = loadConfig({
    repoPath: project,
    configFile: extra,
    env: isolatedEnv(dataRoot),
  });
  assert.deepEqual(cfg.platform.skip_skills, ["c"]);
});

test("CLI exits 1 on bad config", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const file = join(tmp("devkit-cfg-"), "bad.yaml");
  writeFileSync(file, "verification:\n  level: nope\n");
  const chunks: string[] = [];
  const code = await runCli(
    ["node", "devkit", "--path", repo, "--config", file, "init"],
    isolatedEnv(dataRoot),
    silentIo(chunks),
  );
  assert.equal(code, 1);
  assert.match(chunks.join(""), /Invalid verification\.level/);
});

test("CLI flags without a command still fail on bad config", async () => {
  const dataRoot = tmp("devkit-data-");
  const env = isolatedEnv(dataRoot);
  const badLevel = await runCli(["node", "devkit", "--verification", "nope"], env, silentIo());
  assert.equal(badLevel, 1);
  const missing = join(tmp("devkit-cfg-"), "missing.yaml");
  const badFile = await runCli(["node", "devkit", "--config", missing], env, silentIo());
  assert.equal(badFile, 1);
});

test("unknown command does not write user data", async () => {
  const dataRoot = tmp("devkit-data-");
  const code = await runCli(["node", "devkit", "foobar"], isolatedEnv(dataRoot), silentIo());
  assert.equal(code, 1);
  assert.equal(existsSync(join(dataRoot, "devkit", "playbooks")), false);
});
