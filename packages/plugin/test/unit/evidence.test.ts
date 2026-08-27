import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evidenceGateExit,
  looksLikeArgv,
} from "../../src/lib/gates/evidence.js";

test("evidence gate table maps fail and error", () => {
  assert.equal(evidenceGateExit({ ok: true, verdict: "pass" }), 0);
  assert.equal(evidenceGateExit({ ok: true, verdict: "skipped" }), 0);
  assert.equal(evidenceGateExit({ ok: false, verdict: "fail" }), 2);
  assert.equal(evidenceGateExit({ ok: false, verdict: "no_command" }), 2);
  assert.equal(evidenceGateExit({ ok: false, verdict: "denied" }), 2);
  assert.equal(evidenceGateExit({ ok: false, verdict: "error" }), 3);
});

test("looksLikeArgv detects runners and spaces", () => {
  assert.equal(looksLikeArgv("pnpm test"), true);
  assert.equal(looksLikeArgv("pnpm"), true);
  assert.equal(looksLikeArgv("playbook-key-only"), false);
});
