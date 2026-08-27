import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, tuneRevert } from "@coredevkit/platform";
import { loadSkillBody } from "../../src/lib/skill-runner.js";

const dirs: string[] = [];
const fixtureSkills = fileURLToPath(
  new URL("../fixtures/skills", import.meta.url),
);

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
  const dir = tmp("devkit-sk-repo-");
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
  return env;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-SK-02 loadSkillBody concatenates override under Personal override and caps 40 lines", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  mkdirSync(ctx.paths.overridesDir, { recursive: true });
  const lines = [
    "## Personal override",
    "",
    ...Array.from({ length: 50 }, (_, i) => `override ${i + 1}`),
  ];
  writeFileSync(
    join(ctx.paths.overridesDir, "fixture-skill.override.md"),
    `${lines.join("\n")}\n`,
  );
  const body = loadSkillBody(ctx, "fixture-skill", fixtureSkills);
  assert.match(body, /Shipped body line/);
  assert.match(body, /## Personal override/);
  const parts = body.split("## Personal override");
  assert.equal(parts.length, 2);
  const overrideLines = (parts[1] ?? "")
    .replace(/^\n+/, "")
    .split("\n")
    .filter((l) => l.length > 0);
  assert.ok(overrideLines.length <= 40);
  assert.equal(body.includes("override 50"), false);
});

test("T-SK-03 tuneRevert then loadSkillBody is shipped-only", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
  });
  mkdirSync(ctx.paths.overridesDir, { recursive: true });
  writeFileSync(
    join(ctx.paths.overridesDir, "fixture-skill.override.md"),
    "Keep this extra line from the user.\n",
  );
  const withOverride = loadSkillBody(ctx, "fixture-skill", fixtureSkills);
  assert.match(withOverride, /## Personal override/);
  assert.match(withOverride, /Keep this extra line/);
  await tuneRevert(ctx, "fixture-skill");
  const shipped = loadSkillBody(ctx, "fixture-skill", fixtureSkills);
  assert.match(shipped, /Shipped body line/);
  assert.equal(shipped.includes("## Personal override"), false);
  assert.equal(shipped.includes("Keep this extra line"), false);
});
