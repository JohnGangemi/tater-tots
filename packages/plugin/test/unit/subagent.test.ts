import assert from "node:assert/strict";
import { test } from "node:test";
import { PLUGIN_SHIPPED_DEFAULTS } from "../../src/lib/plugin-config.js";
import { resolveSubagent } from "../../src/lib/subagents/resolve.js";

test("resolveSubagent reads the coder name from config", () => {
  const cfg = structuredClone(PLUGIN_SHIPPED_DEFAULTS);
  cfg.subagents.coder = "my-coder";
  assert.equal(resolveSubagent(cfg, "coder"), "my-coder");
  assert.equal(resolveSubagent(PLUGIN_SHIPPED_DEFAULTS, "coder"), "coder");
});

test("resolveSubagent reads the reviewer name from config", () => {
  const cfg = structuredClone(PLUGIN_SHIPPED_DEFAULTS);
  cfg.subagents.reviewer = "my-reviewer";
  assert.equal(resolveSubagent(cfg, "reviewer"), "my-reviewer");
  assert.equal(
    resolveSubagent(PLUGIN_SHIPPED_DEFAULTS, "reviewer"),
    "reviewer",
  );
});
