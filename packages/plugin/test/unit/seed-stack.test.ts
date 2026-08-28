import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginError } from "../../src/lib/errors.js";
import {
  assertStackPrs,
  seedStackPrs,
} from "../../src/lib/coordinator/seed-stack.js";
import type {
  CoordinatorStep,
  StackPr,
} from "../../src/lib/coordinator/types.js";
import type { StackItem } from "../../src/lib/plan/intent.js";

function step(id: string, path: string): CoordinatorStep {
  return {
    id,
    step_title: id,
    title: id,
    status: "pending",
    allowed_paths: [path],
    evidence: null,
    summaries: [],
    blocked_reason: null,
    stack_id: null,
  };
}

function item(
  id: string,
  step_ids: string[],
  depends_on: string[] = [],
): StackItem {
  return {
    id,
    title: id,
    branch: `feat/${id}`,
    base: depends_on[0] ?? "@default",
    step_ids,
    depends_on,
  };
}

function pr(stack_id: string, phase: StackPr["phase"]): StackPr {
  return {
    stack_id,
    branch: `feat/${stack_id}`,
    base: "@default",
    pr_number: null,
    pr_url: null,
    pr_state: "none",
    phase,
    commit_sha: null,
    allowed_paths: ["a.ts"],
  };
}

test("seedStackPrs create seeds phase none from intent stack", () => {
  const out = seedStackPrs(
    [item("A", ["S1"]), item("B", ["S2"], ["A"])],
    [step("S1", "a.ts"), step("S2", "b.ts")],
    [],
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]?.stack_id, "A");
  assert.equal(out[0]?.phase, "none");
  assert.equal(out[1]?.stack_id, "B");
  assert.deepEqual(out[0]?.allowed_paths, ["a.ts"]);
});

test("seedStackPrs merge does not reset a row past none", () => {
  const existing = [
    { ...pr("A", "checked_out"), branch: "feat/a-live", commit_sha: "abc" },
  ];
  const out = seedStackPrs(
    [item("A", ["S1"]), item("B", ["S2"], ["A"])],
    [step("S1", "a.ts"), step("S2", "b.ts")],
    existing,
  );
  const a = out.find((p) => p.stack_id === "A");
  const b = out.find((p) => p.stack_id === "B");
  assert.equal(a?.phase, "checked_out");
  assert.equal(a?.branch, "feat/a-live");
  assert.equal(a?.commit_sha, "abc");
  assert.equal(b?.phase, "none");
});

test("assertStackPrs rejects enabled with empty prs", () => {
  assert.throws(
    () => assertStackPrs(true, []),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.match(
        (err as PluginError).message,
        /stack.enabled but stack.prs is empty/,
      );
      return true;
    },
  );
});
