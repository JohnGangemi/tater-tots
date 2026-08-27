import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { createContext } from "@coredevkit/platform";
import { runPluginCli, type PluginCliIo } from "../../src/cli.js";
import { loadSkillBody } from "../../src/lib/skill-runner.js";

const dirs: string[] = [];
const pluginRoot = fileURLToPath(new URL("../..", import.meta.url));
const shippedSkills = join(pluginRoot, "skills");
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;

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
  const dir = tmp("devkit-sk01-repo-");
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

function shippedSkillNames(): string[] {
  return readdirSync(shippedSkills, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function parseSkill(name: string): {
  name: string;
  description: string;
  bodyLines: number;
} {
  const text = readFileSync(join(shippedSkills, name, "SKILL.md"), "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  assert.ok(m, `${name} has YAML frontmatter`);
  const raw: unknown = parseYaml(m[1] ?? "");
  assert.equal(typeof raw, "object");
  const map = raw as { name?: unknown; description?: unknown };
  assert.equal(typeof map.name, "string");
  assert.equal(typeof map.description, "string");
  const body = m ? text.slice(m[0].length) : text;
  return {
    name: map.name as string,
    description: (map.description as string).trim(),
    bodyLines: body.split(/\r?\n/).length,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-SK-01 each shipped skill is kebab-case with triggers and body under 500 lines", () => {
  const names = shippedSkillNames();
  assert.ok(names.includes("debug"));
  assert.ok(names.includes("review"));
  assert.ok(names.includes("finish"));
  for (const name of names) {
    assert.ok(SKILL_NAME_RE.test(name), name);
    assert.ok(name.length <= SKILL_NAME_MAX, name);
    assert.equal(existsSync(join(shippedSkills, name, "README.md")), false);
    assert.equal(existsSync(join(shippedSkills, name, "SKILL.md")), true);
    const parsed = parseSkill(name);
    assert.equal(parsed.name, name);
    assert.ok(parsed.description.length > 0);
    assert.ok(parsed.description.length <= 1024, name);
    assert.match(parsed.description, /trigger/i);
    assert.equal(parsed.description.includes("<"), false, name);
    assert.ok(parsed.bodyLines < 500, `${name} body ${parsed.bodyLines}`);
  }
});

test("T-SK-01 loadSkillBody and skill show load debug review finish", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  for (const name of ["debug", "review", "finish"] as const) {
    const body = loadSkillBody(ctx, name, shippedSkills);
    assert.match(body, /Personal override/);
    assert.match(body, /logical names/);
    const cap = captureIo();
    const code = await runPluginCli(
      ["node", "devkit", "--path", repo, "skill", "show", name],
      env,
      cap.io,
    );
    assert.equal(code, 0, cap.err());
    assert.match(cap.out(), /Personal override/);
  }
});

test("reviewer agent is read-only and named reviewer", () => {
  const text = readFileSync(join(pluginRoot, "agents", "reviewer.md"), "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m);
  const raw: unknown = parseYaml(m[1] ?? "");
  const map = raw as { name?: unknown; tools?: unknown; description?: unknown };
  assert.equal(map.name, "reviewer");
  assert.match(String(map.description), /trigger/i);
  const tools = String(map.tools ?? "");
  assert.match(tools, /Read/);
  assert.match(tools, /graph_impact/);
  assert.doesNotMatch(tools, /\bWrite\b/);
  assert.doesNotMatch(tools, /\bEdit\b/);
  assert.match(text, /Read-only/);
  assert.match(text, /Do not mark the\s+coordinator done/);
});
