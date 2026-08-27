import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { adversarialReview } from "./lib/adversarial/review.js";
import { createContext } from "./lib/context.js";
import { evidenceCheck } from "./lib/evidence/check.js";
import { errorMessage, isPlatformError, PlatformError } from "./lib/errors.js";
import { graphImpact, graphSearch, graphSymbol } from "./lib/graph/tools.js";
import { logPlatform } from "./lib/log.js";
import type { EnvMap } from "./lib/paths.js";
import { playbookLookup, playbookRecord } from "./lib/playbook/store.js";
import { isValidProposalId, tuneAccept, tuneReject, tuneStatus } from "./lib/tune/store.js";

export const MCP_SERVER_NAME = "coredevkit";
export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_TOOL_NAMES = [
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

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpRunOpts = {
  cwd?: string;
  env?: EnvMap;
  configFile?: string;
  verification?: string;
};

const GRAPH_SEARCH_SCHEMA = {
  type: "object" as const,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 200 },
    path: { type: "string", maxLength: 400 },
  },
  required: ["query"],
  additionalProperties: false,
};

const GRAPH_SYMBOL_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["name"],
  additionalProperties: false,
};

const GRAPH_IMPACT_SCHEMA = {
  type: "object" as const,
  oneOf: [
    {
      type: "object" as const,
      properties: { path: { type: "string", minLength: 1, maxLength: 400 } },
      required: ["path"],
      additionalProperties: false,
    },
    {
      type: "object" as const,
      properties: { symbol: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["symbol"],
      additionalProperties: false,
    },
  ],
};

const PLAYBOOK_LOOKUP_SCHEMA = {
  type: "object" as const,
  properties: {
    purpose: { type: "string", maxLength: 40 },
    prefix: { type: "string", maxLength: 200 },
  },
  additionalProperties: false,
  anyOf: [{ required: ["purpose"] }, { required: ["prefix"] }],
};

const PLAYBOOK_RECORD_SCHEMA = {
  type: "object" as const,
  properties: {
    raw_command: { type: "string", minLength: 1, maxLength: 4000 },
    cwd: { type: "string", minLength: 1 },
    exit: { type: "integer" },
    duration: { type: "number" },
    tool_name: { type: "string" },
  },
  required: ["raw_command", "cwd", "exit", "duration"],
  additionalProperties: false,
};

const EVIDENCE_CHECK_SCHEMA = {
  type: "object" as const,
  properties: {
    command: { type: "string", maxLength: 4000 },
    purpose: { type: "string", maxLength: 40 },
    force: { type: "boolean" },
  },
  additionalProperties: false,
};

const ADVERSARIAL_REVIEW_SCHEMA = {
  type: "object" as const,
  properties: {
    plan_path: { type: "string", minLength: 1, maxLength: 400 },
  },
  required: ["plan_path"],
  additionalProperties: false,
};

const TUNE_STATUS_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

const TUNE_PROPOSAL_SCHEMA = {
  type: "object" as const,
  properties: {
    proposal_id: { type: "string", minLength: 1, maxLength: 64 },
  },
  required: ["proposal_id"],
  additionalProperties: false,
};

const TOOLS: Tool[] = [
  {
    name: "graph_search",
    description: "Search the local code graph. Returns at most 15 hits.",
    inputSchema: GRAPH_SEARCH_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: "graph_symbol",
    description: "Look up definitions and inbound refs for a symbol name.",
    inputSchema: GRAPH_SYMBOL_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: "graph_impact",
    description: "Find callers and dependents for a path or a symbol.",
    inputSchema: GRAPH_IMPACT_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: "playbook_lookup",
    description: "Return at most 5 playbook commands that match purpose or prefix.",
    inputSchema: PLAYBOOK_LOOKUP_SCHEMA,
  },
  {
    name: "playbook_record",
    description:
      "Write a command into the personal playbook if it is worthy. For hooks; skills should not need to call this.",
    inputSchema: PLAYBOOK_RECORD_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "evidence_check",
    description:
      "Run a local command or a playbook command. This tool executes a local command. It returns pass or fail and a short tail.",
    inputSchema: EVIDENCE_CHECK_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "adversarial_review",
    description:
      "Read-only review of a plan file. Does not edit the plan. Returns a verdict and at most 7 findings.",
    inputSchema: ADVERSARIAL_REVIEW_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: "tune_status",
    description:
      "List pending skill-override proposal ids. Read-only. Does not write proposals or plugin directories.",
    inputSchema: TUNE_STATUS_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: "tune_accept",
    description:
      "Accept a proposal. Writes user-data only under DEVKIT_HOME/overrides. Does not write plugin or marketplace paths.",
    inputSchema: TUNE_PROPOSAL_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "tune_reject",
    description: "Reject a pending proposal. Does not write an override.",
    inputSchema: TUNE_PROPOSAL_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new PlatformError("usage", "Tool arguments must be an object");
  }
  return value;
}

function noExtra(obj: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      throw new PlatformError("usage", `Unknown field ${key}`);
    }
  }
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  opts: { required: boolean; min: number; max: number },
): string | undefined {
  if (!(key in obj)) {
    if (opts.required) {
      throw new PlatformError("usage", `Missing ${key}`);
    }
    return undefined;
  }
  const value = obj[key];
  if (typeof value !== "string") {
    throw new PlatformError("usage", `${key} must be a string`);
  }
  if (value.length < opts.min || value.length > opts.max) {
    throw new PlatformError("usage", `${key} length is invalid`);
  }
  return value;
}

function parseGraphSearch(raw: unknown): { query: string; path?: string } {
  const obj = asObject(raw);
  noExtra(obj, ["query", "path"]);
  const query = readString(obj, "query", { required: true, min: 1, max: 200 });
  const path = readString(obj, "path", { required: false, min: 0, max: 400 });
  return path !== undefined ? { query: query as string, path } : { query: query as string };
}

function parseGraphSymbol(raw: unknown): { name: string } {
  const obj = asObject(raw);
  noExtra(obj, ["name"]);
  return { name: readString(obj, "name", { required: true, min: 1, max: 200 }) as string };
}

function parseGraphImpact(raw: unknown): { path?: string; symbol?: string } {
  const obj = asObject(raw);
  const hasPath = Object.prototype.hasOwnProperty.call(obj, "path");
  const hasSymbol = Object.prototype.hasOwnProperty.call(obj, "symbol");
  if (hasPath === hasSymbol) {
    throw new PlatformError("usage", "graph_impact needs path or symbol");
  }
  if (hasPath) {
    noExtra(obj, ["path"]);
    return { path: readString(obj, "path", { required: true, min: 1, max: 400 }) };
  }
  noExtra(obj, ["symbol"]);
  return { symbol: readString(obj, "symbol", { required: true, min: 1, max: 200 }) };
}

function parsePlaybookLookup(raw: unknown): { purpose?: string; prefix?: string } {
  const obj = asObject(raw);
  noExtra(obj, ["purpose", "prefix"]);
  const purpose = readString(obj, "purpose", { required: false, min: 0, max: 40 });
  const prefix = readString(obj, "prefix", { required: false, min: 0, max: 200 });
  if (purpose === undefined && prefix === undefined) {
    throw new PlatformError("usage", "playbook_lookup needs purpose or prefix");
  }
  return {
    ...(purpose !== undefined ? { purpose } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
  };
}

function parseEvidenceCheck(raw: unknown): {
  command?: string;
  purpose?: string;
  force?: boolean;
} {
  const obj = asObject(raw);
  noExtra(obj, ["command", "purpose", "force"]);
  const command = readString(obj, "command", { required: false, min: 0, max: 4000 });
  const purpose = readString(obj, "purpose", { required: false, min: 0, max: 40 });
  if ("force" in obj && typeof obj.force !== "boolean") {
    throw new PlatformError("usage", "force must be a boolean");
  }
  const force = typeof obj.force === "boolean" ? obj.force : undefined;
  return {
    ...(command !== undefined ? { command } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    ...(force !== undefined ? { force } : {}),
  };
}

function parseAdversarialReview(raw: unknown): { plan_path: string } {
  const obj = asObject(raw);
  noExtra(obj, ["plan_path"]);
  return {
    plan_path: readString(obj, "plan_path", { required: true, min: 1, max: 400 }) as string,
  };
}

function parseTuneStatus(raw: unknown): Record<string, never> {
  const obj = asObject(raw);
  noExtra(obj, []);
  return {};
}

function parseTuneProposal(raw: unknown): { proposal_id: string } {
  const obj = asObject(raw);
  noExtra(obj, ["proposal_id"]);
  const proposal_id = readString(obj, "proposal_id", {
    required: true,
    min: 1,
    max: 64,
  }) as string;
  if (!isValidProposalId(proposal_id)) {
    throw new PlatformError("usage", "Invalid proposal id");
  }
  return { proposal_id };
}

function parsePlaybookRecord(raw: unknown): {
  raw_command: string;
  cwd: string;
  exit: number;
  duration: number;
  tool_name?: string;
} {
  const obj = asObject(raw);
  noExtra(obj, ["raw_command", "cwd", "exit", "duration", "tool_name"]);
  const raw_command = readString(obj, "raw_command", {
    required: true,
    min: 1,
    max: 4000,
  }) as string;
  const cwd = readString(obj, "cwd", { required: true, min: 1, max: 32_768 }) as string;
  const exit = obj.exit;
  if (typeof exit !== "number" || !Number.isInteger(exit)) {
    throw new PlatformError("usage", "exit must be an integer");
  }
  const duration = obj.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    throw new PlatformError("usage", "duration must be a number");
  }
  const tool_name = readString(obj, "tool_name", { required: false, min: 0, max: 200 });
  return {
    raw_command,
    cwd,
    exit,
    duration,
    ...(tool_name !== undefined ? { tool_name } : {}),
  };
}

function mcpResult(body: unknown, isError: boolean): CallToolResult {
  const text = JSON.stringify(body);
  const structured = isPlainObject(body) ? body : { value: body };
  const out: CallToolResult = {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
  if (isError) {
    out.isError = true;
  }
  return out;
}

function errorResult(err: unknown, env: EnvMap): CallToolResult {
  if (isPlatformError(err)) {
    logPlatform(env, {
      component: "mcp",
      event: "tool_error",
      code: err.code,
    });
    return mcpResult(err.toJSON(), true);
  }
  logPlatform(env, {
    component: "mcp",
    event: "tool_error",
    code: "internal",
  });
  return mcpResult({ error: { code: "internal", message: errorMessage(err) } }, true);
}

async function dispatch(name: string, args: unknown, opts: McpRunOpts): Promise<unknown> {
  if (!MCP_TOOL_NAMES.includes(name as McpToolName)) {
    throw new PlatformError("not_found", `Unknown tool ${name}`);
  }
  const tool = name as McpToolName;
  const parsed = parseToolArgs(tool, args);
  const ctx = await createContext({
    repoPath: opts.cwd,
    env: opts.env,
    ...(opts.configFile ? { configFile: opts.configFile } : {}),
    ...(opts.verification ? { verification: opts.verification } : {}),
  });
  switch (parsed.tool) {
    case "graph_search":
      return graphSearch(ctx, parsed.q);
    case "graph_symbol":
      return graphSymbol(ctx, parsed.q);
    case "graph_impact":
      return graphImpact(ctx, parsed.q);
    case "playbook_lookup":
      return playbookLookup(ctx, parsed.q);
    case "playbook_record":
      return playbookRecord(ctx, {
        raw_command: parsed.q.raw_command,
        cwd: parsed.q.cwd,
        exit_code: parsed.q.exit,
        duration_ms: parsed.q.duration,
        // ObserveEvent.tool_name is required; hooks record Bash.
        tool_name: parsed.q.tool_name ?? "Bash",
      });
    case "evidence_check":
      return evidenceCheck(ctx, parsed.q);
    case "adversarial_review":
      return adversarialReview(ctx, parsed.q);
    case "tune_status":
      return tuneStatus(ctx);
    case "tune_accept":
      await tuneAccept(ctx, parsed.q.proposal_id);
      return { ok: true };
    case "tune_reject":
      await tuneReject(ctx, parsed.q.proposal_id);
      return { ok: true };
    default: {
      const _never: never = parsed;
      throw new PlatformError("not_found", `Unknown tool ${String(_never)}`);
    }
  }
}

type ParsedTool =
  | { tool: "graph_search"; q: { query: string; path?: string } }
  | { tool: "graph_symbol"; q: { name: string } }
  | { tool: "graph_impact"; q: { path?: string; symbol?: string } }
  | { tool: "playbook_lookup"; q: { purpose?: string; prefix?: string } }
  | {
      tool: "playbook_record";
      q: {
        raw_command: string;
        cwd: string;
        exit: number;
        duration: number;
        tool_name?: string;
      };
    }
  | { tool: "evidence_check"; q: { command?: string; purpose?: string; force?: boolean } }
  | { tool: "adversarial_review"; q: { plan_path: string } }
  | { tool: "tune_status"; q: Record<string, never> }
  | { tool: "tune_accept"; q: { proposal_id: string } }
  | { tool: "tune_reject"; q: { proposal_id: string } };

function parseToolArgs(tool: McpToolName, args: unknown): ParsedTool {
  switch (tool) {
    case "graph_search":
      return { tool, q: parseGraphSearch(args) };
    case "graph_symbol":
      return { tool, q: parseGraphSymbol(args) };
    case "graph_impact":
      return { tool, q: parseGraphImpact(args) };
    case "playbook_lookup":
      return { tool, q: parsePlaybookLookup(args) };
    case "playbook_record":
      return { tool, q: parsePlaybookRecord(args) };
    case "evidence_check":
      return { tool, q: parseEvidenceCheck(args) };
    case "adversarial_review":
      return { tool, q: parseAdversarialReview(args) };
    case "tune_status":
      return { tool, q: parseTuneStatus(args) };
    case "tune_accept":
      return { tool, q: parseTuneProposal(args) };
    case "tune_reject":
      return { tool, q: parseTuneProposal(args) };
    default: {
      const _never: never = tool;
      throw new PlatformError("not_found", `Unknown tool ${_never}`);
    }
  }
}

export function createMcpServer(opts: McpRunOpts = {}): Server {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  // McpServer forces listChanged true.
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.onerror = () => {
    logPlatform(env, { component: "mcp", event: "rpc_error", code: "internal" });
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const payload = await dispatch(request.params.name, request.params.arguments, {
        cwd,
        env,
        ...(opts.configFile ? { configFile: opts.configFile } : {}),
        ...(opts.verification ? { verification: opts.verification } : {}),
      });
      return mcpResult(payload, false);
    } catch (err) {
      return errorResult(err, env);
    }
  });
  return server;
}

function waitUntilStdinClose(server: Server): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      void server.close().finally(resolve);
    };
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function runMcpServer(opts: McpRunOpts = {}): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await waitUntilStdinClose(server);
}
