import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseIntent, type PlanIntent } from "../../src/lib/plan/intent.js";
import { renderPlanHtml } from "../../src/lib/plan/render-html.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sixSteps() {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `PS${i + 1}`,
    title: `Process step A${i + 1}`,
    detail: `Do step ${i + 1}.`,
    required: true,
  }));
}

function sample(extra: Partial<PlanIntent> = {}): PlanIntent {
  return parseIntent({
    version: 1,
    title: "Add writing-plans",
    summary: "Ship intent HTML and plan CLI.",
    goal: "Add writing-plans and intent HTML.",
    agent_plan: "/tmp/plan.md",
    theme_default: "system",
    non_goals: [],
    constraints: [],
    assumptions: [],
    open_questions: [
      {
        id: "Q-open",
        ask: "Keep the open question?",
        why_it_matters: "Humans must see it.",
        blocks: true,
        options: [],
        status: "open",
        answer: null,
      },
      {
        id: "Q-done",
        ask: "Which source?",
        why_it_matters: "HTML must follow intent.",
        blocks: false,
        options: ["intent"],
        status: "resolved",
        answer: "intent file",
      },
    ],
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
  });
}

test("T-PL-02 HTML lists six process steps when the intent has six", () => {
  const html = renderPlanHtml(sample());
  const marks = html.match(/data-kind="process-step"/g) ?? [];
  assert.equal(marks.length, 6);
  for (let i = 1; i <= 6; i++) {
    assert.match(html, new RegExp(`Process step A${i}`));
  }
});

test("T-PL-03 open questions appear on the HTML page (open and resolved)", () => {
  const html = renderPlanHtml(sample());
  const marks = html.match(/data-kind="open-question"/g) ?? [];
  assert.equal(marks.length, 2);
  assert.match(html, /Keep the open question\?/);
  assert.match(html, /Which source\?/);
  assert.match(html, /intent file/);
  assert.match(html, /Status: open/);
  assert.match(html, /Status: resolved/);
});

test("T-PL-04 HTML follows intent with six steps when markdown has two or is absent", () => {
  const intent = sample();
  const html = renderPlanHtml(intent);
  assert.equal((html.match(/data-kind="process-step"/g) ?? []).length, 6);
  const dir = tmp("devkit-html-md-");
  writeFileSync(
    join(dir, "plan.md"),
    `# Short\n\n## Steps\n\n1. Only one\n2. Only two\n`,
  );
  const html2 = renderPlanHtml(intent);
  assert.equal((html2.match(/data-kind="process-step"/g) ?? []).length, 6);
  assert.doesNotMatch(html2, /Only one/);
  assert.doesNotMatch(html2, /Only two/);
});

test("T-PL-07 default HTML has no implementation pre code", () => {
  const html = renderPlanHtml(sample());
  assert.equal(html.includes("<pre><code"), false);
  assert.equal(html.includes('class="language-'), false);
});

test("T-PL-08 theme data-theme supports system, light, and dark", () => {
  const html = renderPlanHtml(sample());
  assert.match(html, /data-theme="system"/);
  assert.match(html, /data-set-theme="system"/);
  assert.match(html, /data-set-theme="light"/);
  assert.match(html, /data-set-theme="dark"/);
  assert.match(html, /:root\[data-theme="light"\]/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /:root\[data-theme="system"\]/);
  assert.match(html, /coredevkit-plan-theme/);
  const dark = renderPlanHtml(sample({ theme_default: "dark" }));
  assert.match(dark, /<html lang="en" data-theme="dark">/);
});

test("T-PL-09 title and ask special characters are escaped and not in attributes", () => {
  const title = `A & B <C> "D" 'E'`;
  const ask = `Use & < > " ' in the ask`;
  const html = renderPlanHtml(
    sample({
      title,
      open_questions: [
        {
          id: "Q1",
          ask,
          why_it_matters: "Escape test.",
          blocks: false,
          options: [],
          status: "open",
          answer: null,
        },
      ],
    }),
  );
  assert.match(html, /A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;/);
  assert.match(html, /Use &amp; &lt; &gt; &quot; &#39; in the ask/);
  assert.equal(html.includes(title), false);
  assert.equal(html.includes("<C>"), false);
  const attrs = [...html.matchAll(/[a-zA-Z-]+="([^"]*)"/g)].map(
    (m) => m[1] ?? "",
  );
  for (const value of attrs) {
    assert.equal(value.includes(title), false);
    assert.equal(value.includes(ask), false);
    assert.equal(value.includes("<C>"), false);
  }
});
