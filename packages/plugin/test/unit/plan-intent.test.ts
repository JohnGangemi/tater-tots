import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginError } from "../../src/lib/errors.js";
import {
  finalizeResolvedQuestions,
  parseIntent,
  type PlanIntent,
} from "../../src/lib/plan/intent.js";

function sixSteps() {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `PS${i + 1}`,
    title: `Process step A${i + 1}`,
    detail: `Do step ${i + 1}.`,
    required: true,
  }));
}

function sample(extra: Partial<PlanIntent> = {}): PlanIntent {
  return {
    version: 1,
    title: "Add writing-plans",
    summary: "Ship intent HTML and plan CLI.",
    goal: "Add writing-plans and intent HTML.",
    agent_plan: "/tmp/plan.md",
    theme_default: "system",
    non_goals: [],
    constraints: [],
    assumptions: [],
    open_questions: [],
    components: [
      { id: "c1", name: "plugin", path: "packages/plugin", role: "lib" },
    ],
    processes: [
      {
        id: "p1",
        title: "Ship plan",
        complete: true,
        steps: sixSteps(),
      },
    ],
    sequences: [],
    stack: [],
    risks: [],
    ...extra,
  };
}

test("T-PL-05 sequence process_id with a foreign step id fails validate", () => {
  const raw = sample({
    sequences: [
      {
        id: "seq1",
        title: "Highlight",
        process_id: "p1",
        step_ids: ["PS1", "foreign"],
      },
    ],
  });
  assert.throws(
    () => parseIntent(raw),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.match(
        (err as PluginError).message,
        /sequence seq1 step foreign is not in process p1/,
      );
      return true;
    },
  );
});

test("T-PL-05 complete true with empty steps fails validate", () => {
  const raw = sample({
    processes: [{ id: "p1", title: "Empty", complete: true, steps: [] }],
  });
  assert.throws(
    () => parseIntent(raw),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.match((err as PluginError).message, /complete is true/);
      return true;
    },
  );
});

test("T-PL-05 complete true with a non-required step fails validate", () => {
  const steps = sixSteps();
  const last = steps[5];
  assert.ok(last);
  last.required = false;
  const raw = sample({
    processes: [{ id: "p1", title: "Ship plan", complete: true, steps }],
  });
  assert.throws(
    () => parseIntent(raw),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.match((err as PluginError).message, /complete is true/);
      return true;
    },
  );
});

test("T-PL-06 resolved question remains in open_questions and assumptions", () => {
  const intent = parseIntent(
    sample({
      open_questions: [
        {
          id: "Q1",
          ask: "Which renderer?",
          why_it_matters: "HTML must follow intent.",
          blocks: false,
          options: ["intent", "markdown"],
          status: "resolved",
          answer: "Render from intent only",
        },
      ],
    }),
  );
  finalizeResolvedQuestions(intent);
  const q = intent.open_questions.find((item) => item.id === "Q1");
  assert.ok(q);
  assert.equal(q.status, "resolved");
  assert.equal(q.answer, "Render from intent only");
  assert.ok(
    intent.assumptions.includes("Resolved Q-Q1: Render from intent only"),
  );
  finalizeResolvedQuestions(intent);
  assert.equal(
    intent.assumptions.filter((a) => a.startsWith("Resolved Q-Q1:")).length,
    1,
  );
});
