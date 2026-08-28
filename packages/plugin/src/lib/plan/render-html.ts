import { dirname } from "node:path";
import {
  applyUserOnlyDirSync,
  applyUserOnlyFileSync,
  mkdirUserOnly,
  writeFileAtomic,
} from "@coredevkit/platform";
import {
  loadIntentFile,
  type PlanIntent,
  type ThemeDefault,
} from "./intent.js";
import { PLAN_THEME_CSS } from "./theme.css.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function themeAttr(theme: ThemeDefault): ThemeDefault {
  if (theme === "light" || theme === "dark" || theme === "system") {
    return theme;
  }
  return "system";
}

function listOrNone(items: string[]): string {
  if (items.length === 0) {
    return "<p>None</p>";
  }
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function fenceToHtml(text: string): string {
  const parts: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push(`<p>${escapeHtml(text.slice(last, m.index))}</p>`);
    const body = m[1] ?? "";
    parts.push(`<pre><code>${escapeHtml(body)}</code></pre>`);
    last = m.index + m[0].length;
  }
  parts.push(`<p>${escapeHtml(text.slice(last))}</p>`);
  return parts.join("");
}

function prose(text: string, codeBlocks: boolean): string {
  if (codeBlocks && text.includes("```")) {
    return fenceToHtml(text);
  }
  return `<p>${escapeHtml(text)}</p>`;
}

const THEME_SCRIPT = `(function(){
  var KEY = "coredevkit-plan-theme";
  var allowed = { system: 1, light: 1, dark: 1 };
  function apply(t) {
    if (!allowed[t]) t = "system";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
  }
  var start = document.documentElement.getAttribute("data-theme") || "system";
  try {
    var saved = localStorage.getItem(KEY);
    if (saved && allowed[saved]) start = saved;
  } catch (e) {}
  apply(start);
  document.querySelectorAll("[data-set-theme]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      apply(btn.getAttribute("data-set-theme"));
    });
  });
})();`;

export function renderPlanHtml(
  intent: PlanIntent,
  opts?: { codeBlocks?: boolean },
): string {
  const codeBlocks = opts?.codeBlocks === true;
  const theme = themeAttr(intent.theme_default);
  const questions = intent.open_questions
    .map((q) => {
      const answer =
        q.status === "resolved" && q.answer
          ? `<p>Answer: ${escapeHtml(q.answer)}</p>`
          : "";
      return `<article data-kind="open-question">
<h3>${escapeHtml(q.id)}</h3>
${prose(q.ask, false)}
<p>${escapeHtml(q.why_it_matters)}</p>
<p>Status: ${escapeHtml(q.status)}. Blocks: ${q.blocks ? "yes" : "no"}.</p>
${q.options.length > 0 ? listOrNone(q.options.map((o) => escapeHtml(o))) : ""}
${answer}
</article>`;
    })
    .join("");

  const processes = intent.processes
    .map((p) => {
      const steps = p.steps
        .map(
          (s) => `<li data-kind="process-step">
<p><strong>${escapeHtml(s.title)}</strong>${s.required ? "" : " (optional)"}</p>
${prose(s.detail, codeBlocks)}
</li>`,
        )
        .join("");
      return `<article>
<h3>${escapeHtml(p.title)}</h3>
<p>${p.complete ? "Complete" : "Incomplete"}.</p>
<ol>${steps}</ol>
</article>`;
    })
    .join("");

  const components = intent.components.map(
    (c) =>
      `${escapeHtml(c.name)} — <code>${escapeHtml(c.path)}</code> (${escapeHtml(c.role)})`,
  );
  const sequences = intent.sequences.map((s) => {
    const link = s.process_id ? ` process ${escapeHtml(s.process_id)}` : "";
    return `${escapeHtml(s.title)}${link}: ${escapeHtml(s.step_ids.join(", ") || "None")}`;
  });
  const stack = intent.stack.map((s) => {
    const deps = s.depends_on.length > 0 ? s.depends_on.join(", ") : "None";
    return `${escapeHtml(s.title)} branch <code>${escapeHtml(s.branch)}</code> base <code>${escapeHtml(s.base)}</code> depends on ${escapeHtml(deps)}`;
  });
  const risks = intent.risks.map(
    (r) =>
      `${escapeHtml(r.severity)}: ${escapeHtml(r.claim)} — ${escapeHtml(r.mitigation)}`,
  );

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(intent.title)}</title>
<style>
${PLAN_THEME_CSS}
</style>
</head>
<body>
<h1>${escapeHtml(intent.title)}</h1>
<div class="theme-controls" role="group" aria-label="Theme">
<button type="button" data-set-theme="system">System</button>
<button type="button" data-set-theme="light">Light</button>
<button type="button" data-set-theme="dark">Dark</button>
</div>
<p class="muted">${escapeHtml(intent.summary)}</p>
<section>
<h2>Goal</h2>
${prose(intent.goal, false)}
</section>
<section>
<h2>Non-goals</h2>
${listOrNone(intent.non_goals.map((s) => escapeHtml(s)))}
</section>
<section>
<h2>Constraints</h2>
${listOrNone(intent.constraints.map((s) => escapeHtml(s)))}
</section>
<section>
<h2>Assumptions</h2>
${listOrNone(intent.assumptions.map((s) => escapeHtml(s)))}
</section>
<section>
<h2>Open questions</h2>
${intent.open_questions.length === 0 ? "<p>None</p>" : questions}
</section>
<section>
<h2>Components</h2>
${listOrNone(components)}
</section>
<section>
<h2>Processes</h2>
${intent.processes.length === 0 ? "<p>None</p>" : processes}
</section>
<section>
<h2>Sequences</h2>
${listOrNone(sequences)}
</section>
<section>
<h2>Stack</h2>
${listOrNone(stack)}
</section>
<section>
<h2>Risks</h2>
${listOrNone(risks)}
</section>
<footer>Generated from plan.intent.json. Agents use plan.md.</footer>
<script>
${THEME_SCRIPT}
</script>
</body>
</html>
`;
}

export async function renderPlanHtmlFile(
  intentPath: string,
  htmlPath: string,
  opts?: { codeBlocks?: boolean },
): Promise<void> {
  const intent = loadIntentFile(intentPath, {
    htmlCodeBlocks: opts?.codeBlocks,
  });
  const html = renderPlanHtml(intent, opts);
  const body = html.endsWith("\n") ? html : `${html}\n`;
  const dir = dirname(htmlPath);
  await mkdirUserOnly(dir);
  applyUserOnlyDirSync(dir);
  await writeFileAtomic(htmlPath, body);
  applyUserOnlyFileSync(htmlPath);
}
