import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_COMMANDS } from "../../src/cli.js";

const pluginRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

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

function readUtf8(rel: string): string {
  return readFileSync(join(pluginRoot, rel), "utf8");
}

test("plugin.json is valid and matches .claude-plugin/plugin.json", () => {
  const root = JSON.parse(readUtf8("plugin.json")) as {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    author?: { name?: unknown };
    license?: unknown;
    keywords?: unknown;
  };
  const claude = JSON.parse(readUtf8(".claude-plugin/plugin.json")) as unknown;
  assert.deepEqual(root, claude);
  assert.equal(root.name, "coredevkit");
  assert.equal(root.version, "0.1.0");
  assert.equal(typeof root.description, "string");
  assert.equal(root.author?.name, "CoreDevKit contributors");
  assert.equal(root.license, "MIT");
  assert.deepEqual(root.keywords, [
    "plan",
    "implement",
    "issue-to-pr",
    "stacked-pr",
  ]);
  assert.equal(existsSync(join(pluginRoot, ".claude-plugin", "skills")), false);
  assert.equal(existsSync(join(pluginRoot, "skills", "writing-plans")), true);
  assert.equal(
    existsSync(join(pluginRoot, "agents", "plan-designer.md")),
    true,
  );
});

test("mcp snippet exposes platform devkit mcp with unprefixed names", () => {
  const pluginMcp = readUtf8(".mcp.json");
  const generic = readUtf8("adapters/generic/mcp.json");
  const platform = readFileSync(
    join(repoRoot, "packages", "platform", "adapters", "generic", "mcp.json"),
    "utf8",
  );
  assert.equal(pluginMcp, generic);
  assert.equal(pluginMcp, platform);
  const parsed = JSON.parse(pluginMcp) as {
    mcpServers?: { coredevkit?: { command?: string; args?: string[] } };
  };
  assert.equal(parsed.mcpServers?.coredevkit?.command, "devkit");
  assert.deepEqual(parsed.mcpServers?.coredevkit?.args, ["mcp"]);
  assert.equal(PLUGIN_COMMANDS.has("mcp"), false);
  assert.equal(LOGICAL_TOOL_NAMES.length, 10);
  const copy = readUtf8("adapters/generic/skills-copy.md");
  for (const name of LOGICAL_TOOL_NAMES) {
    assert.match(copy, new RegExp(`\`${name}\``));
  }
  assert.doesNotMatch(copy, /mcp__coredevkit__plan/);
});

test("adapters document --plugin-dir and that devkit must be on PATH", () => {
  const claude = readUtf8("adapters/claude-code/README.md");
  assert.match(claude, /--plugin-dir packages\/plugin/);
  assert.match(claude, /is not enough/);
  assert.match(claude, /PATH/);
  assert.match(claude, /pnpm add -D @coredevkit\/plugin/);
  const readme = readUtf8("README.md");
  assert.match(readme, /pnpm add -D @coredevkit\/plugin/);
  assert.match(readme, /PATH/);
  assert.match(readme, /--plugin-dir packages\/plugin/);
  const ignore = readUtf8("adapters/generic/gitignore.fragment");
  assert.match(ignore, /--plan/);
  assert.match(ignore, /user-data|DEVKIT_HOME/);
  assert.match(ignore, /plan\.intent\.json/);
  assert.match(ignore, /plan\.md/);
  assert.match(ignore, /plan\.html/);
});

test("acceptance checklist is green and mapped tests exist", () => {
  const text = readUtf8("ACCEPTANCE.md");
  assert.doesNotMatch(text, /^- \[ \]/m);
  const items = text.match(/^- \[x\] /gm) ?? [];
  assert.equal(items.length, 8);
  const ids = [
    "T-IN-P-01",
    "T-IN-P-02",
    "T-CO-01",
    "T-IN-P-07",
    "T-SA-01",
    "T-I2P-01",
    "T-PL-02",
    "T-PL-04",
    "T-IN-P-05",
    "T-IN-P-06",
    "T-AR-P-04",
    "T-IN-P-04",
  ];
  const testRoot = join(pluginRoot, "test");
  const bodies = ["unit", "integration"]
    .flatMap((dir) =>
      readdirSync(join(testRoot, dir))
        .filter((n) => n.endsWith(".test.ts"))
        .map((n) => readFileSync(join(testRoot, dir, n), "utf8")),
    )
    .join("\n");
  for (const id of ids) {
    assert.match(bodies, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(
    existsSync(
      join(repoRoot, "packages", "platform", "skills", "writing-plans"),
    ),
    false,
  );
});
