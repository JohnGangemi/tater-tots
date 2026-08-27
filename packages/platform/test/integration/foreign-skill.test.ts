import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type CliIo } from "../../src/cli.js";
import { adversarialReview } from "../../src/lib/adversarial/review.js";
import { SHIPPED_DEFAULTS } from "../../src/lib/config.js";
import { createContext } from "../../src/lib/context.js";
import { evidenceCheck } from "../../src/lib/evidence/check.js";
import { graphSearch } from "../../src/lib/graph/tools.js";
import { playbookLookup } from "../../src/lib/playbook/store.js";
import { tuneStatus } from "../../src/lib/tune/store.js";
import { createMcpServer, MCP_SERVER_NAME } from "../../src/mcp.js";

const dirs: string[] = [];
const fakeCbmDir = fileURLToPath(new URL("../fixtures/fake-cbm", import.meta.url));
const fakeCbmBin = join(fakeCbmDir, "codebase-memory-mcp");
const skillSrc = fileURLToPath(new URL("../../skills/using-coredevkit/SKILL.md", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const LOGICAL_TOOL_NAMES = [
  "graph_search",
  "graph_symbol",
  "graph_impact",
  "playbook_lookup",
  "playbook_record",
  "evidence_check",
  "adversarial_review",
  "tune_status",
  "tune_accept",
  "tune_reject",
] as const;

const WORKFLOW_SKILLS = ["writing-plans", "implement", "issue-to-pr"] as const;
const FOREIGN_SKILL = "superpowers";

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
  const dir = tmp("devkit-fs-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function basePath(): string {
  return [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
}

function isolatedEnv(
  dataRoot: string,
  extra: { withFakeCbm?: boolean; pathPrefix?: string[] } = {},
): NodeJS.ProcessEnv {
  const home = tmp("devkit-fs-home-");
  const pathParts = [
    ...(extra.pathPrefix ?? []),
    ...(extra.withFakeCbm ? [fakeCbmDir] : []),
    basePath(),
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-fs-xdg-"),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: pathParts.join(delimiter),
    PATHEXT: process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM",
    FAKE_CBM_STATE: join(tmp("fake-cbm-state-"), "state.json"),
  };
  delete env.DEVKIT_CBM_BINARY;
  delete env.DEVKIT_LOG_STDERR;
  delete env.DEVKIT_PLAYBOOK_RESET;
  delete env.DEVKIT_VERIFICATION;
  return env;
}

function captureIo(stdin: string): { io: CliIo; out: () => string; err: () => string } {
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
      stdin: Readable.from([stdin]),
    },
    out: () => out,
    err: () => err,
  };
}

async function runHook(
  kind: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  extra: { path: string },
): Promise<{ code: number; out: string; err: string }> {
  const cap = captureIo(JSON.stringify(payload));
  const code = await runCli(["node", "devkit", "--path", extra.path, "hook", kind], env, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

function isCallToolResult(
  result: ToolCallResult,
): result is Extract<ToolCallResult, { content: unknown[] }> {
  return "content" in result;
}

function toolPayload(result: ToolCallResult): Record<string, unknown> {
  assert.equal(isCallToolResult(result), true);
  if (!isCallToolResult(result)) {
    throw new Error("expected tool result");
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const block = result.content.find((item) => item.type === "text");
  assert.equal(block?.type, "text");
  if (block?.type !== "text") {
    throw new Error("expected text content");
  }
  const parsed: unknown = JSON.parse(block.text);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  return parsed as Record<string, unknown>;
}

async function withMemoryClient(
  cwd: string,
  env: NodeJS.ProcessEnv,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createMcpServer({ cwd, env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devkit-foreign-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function outsideTree(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel.startsWith("..") || isAbsolute(rel);
}

function copySkillToHarness(): string {
  const harness = tmp("devkit-fs-harness-");
  const destDir = join(harness, "skills", "using-coredevkit");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(skillSrc, join(destDir, "SKILL.md"));
  return harness;
}

function writeNodeBin(dir: string, name: string, js: string): void {
  if (process.platform === "win32") {
    const script = join(dir, `${name}.js`);
    writeFileSync(script, js);
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
    return;
  }
  writeFileSync(join(dir, name), `#!${process.execPath}\n${js}\n`);
  chmodSync(join(dir, name), 0o755);
}

function additionalContext(out: string): string {
  const parsed: unknown = JSON.parse(out.trim());
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  const spec = (parsed as { hookSpecificOutput?: { additionalContext?: unknown } })
    .hookSpecificOutput;
  assert.equal(typeof spec, "object");
  assert.notEqual(spec, null);
  const text = spec?.additionalContext;
  assert.equal(typeof text, "string");
  return text as string;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-IN-07 MCP tools/list includes all 10 logical names", async () => {
  assert.equal(LOGICAL_TOOL_NAMES.length, 10);
  const dataRoot = tmp("devkit-fs-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  await withMemoryClient(repo, env, async (client) => {
    assert.equal(client.getServerVersion()?.name, MCP_SERVER_NAME);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...LOGICAL_TOOL_NAMES].sort());
    assert.equal(listed.tools.length, 10);
    const looked = await client.callTool({
      name: "playbook_lookup",
      arguments: { purpose: "test" },
    });
    assert.equal(isCallToolResult(looked) && Boolean(looked.isError), false);
    assert.deepEqual(toolPayload(looked).commands, []);
  });
});

test("T-IN-12 foreign-skill PostToolUse npm test feeds playbook_lookup", async () => {
  const dataRoot = tmp("devkit-fs-data-");
  const main = makeRepo();
  const wt = join(tmp("devkit-fs-wt-"), "wt");
  git(main, ["worktree", "add", "--detach", wt]);
  const env = isolatedEnv(dataRoot);
  const harness = copySkillToHarness();
  assert.equal(existsSync(join(harness, "skills", "using-coredevkit", "SKILL.md")), true);
  const payload = {
    cwd: main,
    hook_event_name: "PostToolUse",
    session_id: "sess-foreign",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: "ok", exitCode: 0 },
    duration_ms: 12,
    skill_name: FOREIGN_SKILL,
    loaded_skills: [FOREIGN_SKILL],
  };
  assert.deepEqual(payload.loaded_skills, [FOREIGN_SKILL]);
  assert.equal(payload.skill_name, FOREIGN_SKILL);
  for (const name of WORKFLOW_SKILLS) {
    assert.equal(existsSync(join(workspaceRoot, "packages", "platform", "skills", name)), false);
  }

  const result = await runHook("post-tool-use", payload, env, { path: main });
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), "");

  await withMemoryClient(wt, env, async (client) => {
    const looked = await client.callTool({
      name: "playbook_lookup",
      arguments: { purpose: "test" },
    });
    assert.equal(isCallToolResult(looked) && Boolean(looked.isError), false);
    const commands = toolPayload(looked).commands as Array<{
      command: string;
      last_status: string;
    }>;
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.command, "npm test");
    assert.equal(commands[0]?.last_status, "pass");
  });

  const ctxMain = await createContext({ repoPath: main, env });
  const ctxWt = await createContext({ repoPath: wt, env });
  assert.equal(ctxMain.paths.playbookFile, ctxWt.paths.playbookFile);
  assert.equal(outsideTree(main, ctxMain.paths.playbookFile), true);
  assert.equal(outsideTree(wt, ctxWt.paths.playbookFile), true);
  assert.equal(ctxMain.paths.playbookFile.startsWith(ctxMain.paths.devkitHome), true);
  assert.equal(existsSync(join(main, "playbook.zst")), false);
  const hits = await playbookLookup(ctxWt, { purpose: "test" });
  assert.equal(hits.commands[0]?.command, "npm test");
});

test("acceptance: devkit init produces a usable local graph", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-fs-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot, { withFakeCbm: true });
  const cap = captureIo("");
  const code = await runCli(["node", "devkit", "--path", repo, "init"], env, cap.io);
  assert.equal(code, 0);
  assert.match(cap.out(), /graph: ready/);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(existsSync(ctx.paths.cbmProjectFile), true);
  const search = await graphSearch(ctx, { query: "HandleRequest" });
  assert.equal(search.graph, "ready");
  assert.ok(search.hits.length > 0);
});

test("acceptance: evidence tool can pass or fail a real command", async () => {
  const dataRoot = tmp("devkit-fs-data-");
  const repo = makeRepo();
  const binDir = tmp("devkit-fs-bin-");
  writeNodeBin(binDir, "okcmd", 'process.stdout.write("ok-tail\\n"); process.exit(0);');
  writeNodeBin(binDir, "badcmd", 'process.stdout.write("fail-tail\\n"); process.exit(1);');
  const env = isolatedEnv(dataRoot, { pathPrefix: [binDir] });
  const ctx = await createContext({ repoPath: repo, env });
  const pass = await evidenceCheck(ctx, { command: "okcmd" });
  assert.equal(pass.ok, true);
  assert.equal(pass.verdict, "pass");
  assert.match(pass.tail, /ok-tail/);
  const fail = await evidenceCheck(ctx, { command: "badcmd" });
  assert.equal(fail.ok, false);
  assert.equal(fail.verdict, "fail");
  assert.match(fail.tail, /fail-tail/);
});

test("acceptance: adversarial tool returns a contract-valid payload", async () => {
  const dataRoot = tmp("devkit-fs-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "ok.ts"), "export {}\n");
  const plan = join(repo, "pass.md");
  const before = "# Plan\n\n1. Add the helper in `src/ok.ts`.\n2. Keep the numbered steps.\n";
  writeFileSync(plan, before);
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  const reviewed = await adversarialReview(ctx, { plan_path: "pass.md" });
  assert.ok(["PASS", "PATCH", "BLOCK"].includes(reviewed.verdict));
  assert.ok(Array.isArray(reviewed.findings));
  assert.ok(reviewed.findings.length <= 7);
  assert.equal(typeof reviewed.dropped_illegal, "number");
  assert.equal(typeof reviewed.graph_ready, "boolean");
  assert.equal(reviewed.resolved_level, "light");
  for (const finding of reviewed.findings) {
    assert.match(finding.id, /^AR-\d{3}$/);
    assert.ok(["patch-plan", "block", "note"].includes(finding.tag));
    assert.ok(["graph", "filesystem", "playbook", "none"].includes(finding.evidence_type));
    assert.equal(typeof finding.category, "string");
    assert.equal(typeof finding.claim, "string");
    assert.equal(typeof finding.evidence, "string");
    assert.equal(typeof finding.plan_target, "string");
    assert.ok(finding.patch === null || typeof finding.patch === "string");
    assert.equal(finding.tag === "block" && finding.evidence_type === "none", false);
    assert.equal(finding.tag === "patch-plan" && finding.evidence_type === "none", false);
  }
  if (reviewed.verdict === "BLOCK") {
    assert.equal(
      reviewed.findings.some((f) => f.tag === "block"),
      true,
    );
  }
  if (reviewed.verdict === "PASS") {
    assert.equal(
      reviewed.findings.some((f) => f.tag === "block" || f.tag === "patch-plan"),
      false,
    );
  }
  assert.equal(readFileSync(plan, "utf8"), before);
});

test("acceptance: tuning cannot auto-accept unless the user sets it", async () => {
  assert.equal(SHIPPED_DEFAULTS.tuning.auto_accept, false);
  const dataRoot = tmp("devkit-fs-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(ctx.config.tuning.auto_accept, false);
  const status = await tuneStatus(ctx);
  assert.equal(status.auto_accept, false);
  await withMemoryClient(repo, env, async (client) => {
    const listed = await client.callTool({ name: "tune_status", arguments: {} });
    assert.equal(isCallToolResult(listed) && Boolean(listed.isError), false);
    const body = toolPayload(listed);
    assert.equal(body.auto_accept, false);
  });
});

test("acceptance: SessionStart does not inject a full methodology", async () => {
  const dataRoot = tmp("devkit-fs-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const result = await runHook(
    "session-start",
    {
      cwd: repo,
      hook_event_name: "SessionStart",
      session_id: "sess-raw",
      source: "startup",
    },
    env,
    { path: repo },
  );
  assert.equal(result.code, 0);
  const pointer = additionalContext(result.out);
  const lines = pointer.split("\n");
  assert.ok(lines.length > 0);
  assert.ok(lines.length <= 20);
  assert.match(pointer, /^CoreDevKit platform$/m);
  assert.doesNotMatch(pointer, /writing-plans|issue-to-pr|methodology|stacked|coordinator|HTML/i);
});

test("using-coredevkit is thin and plugin workflows are absent", () => {
  const body = readFileSync(skillSrc, "utf8");
  const lines = body.split("\n");
  assert.ok(lines.length < 80, `SKILL.md has ${lines.length} lines`);
  assert.match(body, /^name: using-coredevkit$/m);
  assert.match(
    body,
    /Triggers:\s*coredevkit,\s*code graph,\s*playbook,\s*evidence_check,\s*adversarial_review,\s*verification gate\./,
  );
  assert.match(body, /graph_search/);
  assert.match(body, /graph_symbol/);
  assert.match(body, /graph_impact/);
  assert.match(body, /playbook_lookup/);
  assert.match(body, /evidence_check/);
  assert.match(body, /tune_status/);
  assert.match(body, /tune_accept/);
  assert.doesNotMatch(body, /writing-plans|issue-to-pr|HTML|coordinator|stacked/i);
  assert.equal(existsSync(join(workspaceRoot, "packages", "plugin")), false);
  for (const name of WORKFLOW_SKILLS) {
    assert.equal(existsSync(join(workspaceRoot, "packages", "platform", "skills", name)), false);
  }
  const readme = readFileSync(join(workspaceRoot, "packages", "platform", "README.md"), "utf8");
  assert.match(readme, /"args": \["mcp"\]/);
  assert.match(readme, /devkit init/);
  assert.match(readme, /DEVKIT_HOME\/bin/);
  assert.match(readme, /PATH/);
  assert.match(readme, /MCP/);
});
