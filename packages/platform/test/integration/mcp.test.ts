import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type CliIo } from "../../src/cli.js";
import { createMcpServer, MCP_SERVER_NAME, MCP_TOOL_NAMES } from "../../src/mcp.js";

const dirs: string[] = [];
const fakeCbmDir = fileURLToPath(new URL("../fixtures/fake-cbm", import.meta.url));
const fakeCbmBin = join(fakeCbmDir, "codebase-memory-mcp");
const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const platformCli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

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
  const dir = tmp("devkit-mcp-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function basePath(): string {
  return [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
}

function isolatedEnv(dataRoot: string, extra: { withFakeCbm?: boolean } = {}): NodeJS.ProcessEnv {
  const home = tmp("devkit-home-");
  const pathParts = extra.withFakeCbm ? [fakeCbmDir, basePath()] : [basePath()];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: pathParts.join(delimiter),
    FAKE_CBM_STATE: join(tmp("fake-cbm-state-"), "state.json"),
  };
  delete env.DEVKIT_CBM_BINARY;
  delete env.DEVKIT_LOG_STDERR;
  delete env.DEVKIT_PLAYBOOK_RESET;
  return env;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function silentIo(): CliIo {
  return {
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  };
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
  extra: { configFile?: string; verification?: string } = {},
): Promise<void> {
  const server = createMcpServer({ cwd, env, ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devkit-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools/list has registered tools with design JSON Schema", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  await withMemoryClient(repo, env, async (client) => {
    assert.equal(client.getServerVersion()?.name, MCP_SERVER_NAME);
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...MCP_TOOL_NAMES].sort());
    assert.equal(listed.tools.length, MCP_TOOL_NAMES.length);
    assert.equal(
      listed.tools.some((t) => t.name === "tune_status"),
      true,
    );
    assert.equal(
      listed.tools.some((t) => t.name === "tune_accept"),
      true,
    );
    assert.equal(
      listed.tools.some((t) => t.name === "tune_reject"),
      true,
    );
    assert.equal(
      listed.tools.some((t) => t.name === "adversarial_review"),
      true,
    );
    assert.equal(
      listed.tools.some((t) => t.name === "evidence_check"),
      true,
    );
    const search = listed.tools.find((t) => t.name === "graph_search");
    assert.equal(search?.inputSchema.type, "object");
    assert.deepEqual(search?.inputSchema.required, ["query"]);
    assert.equal(search?.inputSchema.additionalProperties, false);
    const impact = listed.tools.find((t) => t.name === "graph_impact");
    assert.ok(Array.isArray(impact?.inputSchema.oneOf));
    assert.equal((impact?.inputSchema.oneOf as unknown[]).length, 2);
    const lookup = listed.tools.find((t) => t.name === "playbook_lookup");
    assert.ok(Array.isArray(lookup?.inputSchema.anyOf));
    assert.notEqual(lookup?.annotations?.readOnlyHint, true);
    const record = listed.tools.find((t) => t.name === "playbook_record");
    assert.match(record?.description ?? "", /writes|Write/i);
    assert.match(record?.description ?? "", /hooks/i);
    const evidence = listed.tools.find((t) => t.name === "evidence_check");
    assert.equal(evidence?.inputSchema.type, "object");
    assert.equal(evidence?.inputSchema.additionalProperties, false);
    assert.equal(evidence?.annotations?.readOnlyHint, false);
    assert.match(evidence?.description ?? "", /execut/i);
    const review = listed.tools.find((t) => t.name === "adversarial_review");
    assert.deepEqual(review?.inputSchema.required, ["plan_path"]);
    assert.equal(review?.inputSchema.additionalProperties, false);
    assert.equal(review?.annotations?.readOnlyHint, true);
    assert.match(review?.description ?? "", /does not edit|read-only/i);
    const tuneStatus = listed.tools.find((t) => t.name === "tune_status");
    assert.equal(tuneStatus?.inputSchema.type, "object");
    assert.equal(tuneStatus?.inputSchema.additionalProperties, false);
    const tuneAccept = listed.tools.find((t) => t.name === "tune_accept");
    assert.deepEqual(tuneAccept?.inputSchema.required, ["proposal_id"]);
    assert.equal(tuneAccept?.inputSchema.additionalProperties, false);
    assert.match(tuneAccept?.description ?? "", /user-data|overrides/i);
    const tuneReject = listed.tools.find((t) => t.name === "tune_reject");
    assert.deepEqual(tuneReject?.inputSchema.required, ["proposal_id"]);
  });
});

test("T-IN-08 playbook_lookup MCP result has at most 5 commands", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  await withMemoryClient(repo, env, async (client) => {
    const cmds = [
      "npm test",
      "pnpm test",
      "yarn test",
      "bun test",
      "vitest",
      "pytest",
      "go test",
      "cargo test",
    ];
    for (const cmd of cmds) {
      const rec = await client.callTool({
        name: "playbook_record",
        arguments: { raw_command: cmd, cwd: repo, exit: 0, duration: 12 },
      });
      assert.equal(isCallToolResult(rec) && Boolean(rec.isError), false);
      assert.deepEqual(toolPayload(rec), { result: "stored" });
    }
    const looked = await client.callTool({
      name: "playbook_lookup",
      arguments: { purpose: "test" },
    });
    assert.equal(isCallToolResult(looked) && Boolean(looked.isError), false);
    const body = toolPayload(looked);
    const commands = body.commands;
    assert.ok(Array.isArray(commands));
    assert.ok((commands as unknown[]).length <= 5);
    assert.equal((commands as unknown[]).length, 5);
  });
});

test("playbook_record maps exit/duration and treats stored|excluded|redacted as success", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  await withMemoryClient(repo, env, async (client) => {
    const stored = await client.callTool({
      name: "playbook_record",
      arguments: { raw_command: "npm test", cwd: repo, exit: 1, duration: 42 },
    });
    assert.equal(isCallToolResult(stored) && Boolean(stored.isError), false);
    assert.deepEqual(toolPayload(stored), { result: "stored" });

    const excluded = await client.callTool({
      name: "playbook_record",
      arguments: { raw_command: "ls -lah", cwd: repo, exit: 0, duration: 5 },
    });
    assert.equal(isCallToolResult(excluded) && Boolean(excluded.isError), false);
    assert.deepEqual(toolPayload(excluded), { result: "excluded" });

    const redacted = await client.callTool({
      name: "playbook_record",
      arguments: {
        raw_command: "npm test --token aabbccdd1122",
        cwd: repo,
        exit: 0,
        duration: 5,
      },
    });
    assert.equal(isCallToolResult(redacted) && Boolean(redacted.isError), false);
    assert.deepEqual(toolPayload(redacted), { result: "redacted" });

    const looked = await client.callTool({
      name: "playbook_lookup",
      arguments: { purpose: "test" },
    });
    const commands = toolPayload(looked).commands as Array<{
      command: string;
      last_status: string;
    }>;
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.command, "npm test");
    assert.equal(commands[0]?.last_status, "fail");
  });
});

test("isError is true only for PlatformError", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  await withMemoryClient(repo, env, async (client) => {
    const missing = await client.callTool({
      name: "graph_search",
      arguments: { query: "HandleRequest" },
    });
    assert.equal(isCallToolResult(missing) && Boolean(missing.isError), true);
    const err = toolPayload(missing).error as { code?: string };
    assert.equal(err.code, "graph_unavailable");

    const badImpact = await client.callTool({
      name: "graph_impact",
      arguments: { path: "src/http.ts", symbol: "HandleRequest" },
    });
    assert.equal(isCallToolResult(badImpact) && Boolean(badImpact.isError), true);
    assert.equal((toolPayload(badImpact).error as { code?: string }).code, "usage");

    const badLookup = await client.callTool({
      name: "playbook_lookup",
      arguments: {},
    });
    assert.equal(isCallToolResult(badLookup) && Boolean(badLookup.isError), true);
    assert.equal((toolPayload(badLookup).error as { code?: string }).code, "usage");
  });
});

test("bad tools/call does not create playbook dir", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const playbooks = join(dataRoot, "devkit", "playbooks");
  await withMemoryClient(repo, env, async (client) => {
    const badImpact = await client.callTool({
      name: "graph_impact",
      arguments: { path: "src/http.ts", symbol: "HandleRequest" },
    });
    assert.equal(isCallToolResult(badImpact) && Boolean(badImpact.isError), true);
    assert.equal((toolPayload(badImpact).error as { code?: string }).code, "usage");
    const badLookup = await client.callTool({
      name: "playbook_lookup",
      arguments: {},
    });
    assert.equal(isCallToolResult(badLookup) && Boolean(badLookup.isError), true);
    const badReview = await client.callTool({
      name: "adversarial_review",
      arguments: {},
    });
    assert.equal(isCallToolResult(badReview) && Boolean(badReview.isError), true);
    assert.equal((toolPayload(badReview).error as { code?: string }).code, "usage");
    const badTune = await client.callTool({
      name: "tune_accept",
      arguments: {},
    });
    assert.equal(isCallToolResult(badTune) && Boolean(badTune.isError), true);
    assert.equal((toolPayload(badTune).error as { code?: string }).code, "usage");
    assert.equal(existsSync(playbooks), false);
  });
  assert.equal(existsSync(playbooks), false);
});

test("adversarial_review MCP returns a contract payload and does not edit the plan", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "ok.ts"), "export {}\n");
  const plan = join(repo, "pass.md");
  writeFileSync(plan, "# Plan\n\n1. Add the helper in `src/ok.ts`.\n2. Keep the numbered steps.\n");
  const before = readFileSync(plan, "utf8");
  const env = isolatedEnv(dataRoot);
  await withMemoryClient(repo, env, async (client) => {
    const reviewed = await client.callTool({
      name: "adversarial_review",
      arguments: { plan_path: "pass.md" },
    });
    assert.equal(isCallToolResult(reviewed) && Boolean(reviewed.isError), false);
    const body = toolPayload(reviewed);
    assert.equal(body.verdict, "PASS");
    assert.ok(Array.isArray(body.findings));
    assert.ok((body.findings as unknown[]).length <= 7);
    assert.equal(body.resolved_level, "light");
  });
  assert.equal(readFileSync(plan, "utf8"), before);
});

test("mcp passes verification into createContext", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const playbooks = join(dataRoot, "devkit", "playbooks");
  await withMemoryClient(
    repo,
    env,
    async (client) => {
      const looked = await client.callTool({
        name: "playbook_lookup",
        arguments: { purpose: "test" },
      });
      assert.equal(isCallToolResult(looked) && Boolean(looked.isError), true);
      assert.equal((toolPayload(looked).error as { code?: string }).code, "config");
    },
    { verification: "nope" },
  );
  assert.equal(existsSync(playbooks), false);
});

test("graph tools return short hits after init", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot, { withFakeCbm: true });
  const code = await runCli(["node", "devkit", "--path", repo, "init"], env, silentIo());
  assert.equal(code, 0);
  await withMemoryClient(repo, env, async (client) => {
    const search = await client.callTool({
      name: "graph_search",
      arguments: { query: "HandleRequest" },
    });
    assert.equal(isCallToolResult(search) && Boolean(search.isError), false);
    const body = toolPayload(search);
    const hits = body.hits as unknown[];
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length <= 15);
    assert.equal(hits.length, 1);
    assert.equal(body.graph, "ready");

    const symbol = await client.callTool({
      name: "graph_symbol",
      arguments: { name: "HandleRequest" },
    });
    assert.equal(isCallToolResult(symbol) && Boolean(symbol.isError), false);
    const defs = toolPayload(symbol).definitions as unknown[];
    assert.ok(Array.isArray(defs));
    assert.ok(defs.length <= 10);

    const impact = await client.callTool({
      name: "graph_impact",
      arguments: { symbol: "HandleRequest" },
    });
    assert.equal(isCallToolResult(impact) && Boolean(impact.isError), false);
    const callers = toolPayload(impact).callers as unknown[];
    assert.ok(Array.isArray(callers));
    assert.ok(callers.length <= 20);
  });
});

test("devkit mcp stdio lists registered tools and keeps stdout as JSON-RPC", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const otherCwd = tmp("devkit-mcp-cwd-");
  const env = isolatedEnv(dataRoot);
  const playbooks = join(dataRoot, "devkit", "playbooks");
  assert.equal(existsSync(playbooks), false);
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, platformCli, "--path", repo, "mcp"],
    cwd: otherCwd,
    env: stringEnv(env),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(String(chunk));
  });
  const client = new Client({ name: "devkit-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, MCP_SERVER_NAME);
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), [...MCP_TOOL_NAMES].sort());
    assert.equal(listed.tools.length, MCP_TOOL_NAMES.length);
    assert.equal(existsSync(playbooks), false);
    const looked = await client.callTool({
      name: "playbook_lookup",
      arguments: { purpose: "test" },
    });
    assert.equal(isCallToolResult(looked) && Boolean(looked.isError), false);
    assert.deepEqual(toolPayload(looked).commands, []);
    assert.equal(existsSync(playbooks), true);
    const ids = readdirSync(playbooks);
    assert.equal(ids.length, 1);
    const identity = JSON.parse(
      readFileSync(join(playbooks, ids[0] ?? "", "identity.json"), "utf8"),
    ) as { kind: string };
    assert.equal(identity.kind, "common-dir");
  } finally {
    await client.close();
  }
  assert.equal(stderrChunks.join(""), "");
});
