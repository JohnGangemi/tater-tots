---
name: writing-plans
description: >
  Use when the user says plan, design, writing-plans, or `devkit plan`.
  Builds dual plan output: intent JSON, agent markdown, and human HTML.
  Triggers: plan, design, writing-plans, devkit plan, design intent.
---

Before the steps, if you can run `devkit skill show writing-plans`, obey any
## Personal override section after the shipped steps.

# Writing plans

Call platform tools by logical names: `graph_search`, `graph_symbol`,
`graph_impact`, `playbook_lookup`. If a tool is missing, fail this workflow.
Do not walk the repository when graph tools respond, including zero hits.

Default files live in user-data
`DEVKIT_HOME/plans/<repo-id>/<worktree-hash>/`:
`plan.intent.json`, `plan.md`, `plan.html`. Do not commit them.

## Steps

1. Collect the goal. Run `devkit plan --goal "<goal>"` for the run packet
   (`plan_dir`, graph hints, dispatch). The CLI does not write intent or
   markdown from `--goal`.
2. Call `graph_search` / `graph_symbol` / `graph_impact` first. Stop the
   explore path when they respond.
3. After graph results, dispatch `plan-designer` when there is more than
   one component or a process with two or more required steps. The first
   packet does not set dispatch; you choose after graph. Plan Designer
   writes `plan.intent.json` only. Do not let it write `plan.md`,
   `plan.html`, or source.
4. If you do not dispatch Plan Designer, write a small
   `plan.intent.json` yourself. Follow `references/intent-schema.md`.
   Required: `version` (1), `title`, `summary`, `goal`, `agent_plan`.
   Always include the arrays. Set `process.complete` true only when
   `steps.length >= 1` and every step is required.
5. Keep resolved questions in `open_questions`. Also copy each resolved
   answer into `assumptions` as `Resolved Q-<id>: <answer>`.
6. Write `plan.md` yourself (orchestrator, not Plan Designer). Follow
   `references/plan-md-contract.md`. Numbered steps. Paths in backticks.
   Evidence commands. Stack notes when needed.
7. Run `devkit plan --render --start-coordinator` (add `--plan <dir>` when
   the packet `plan_dir` is not the default). HTML comes from intent, not
   from converting `plan.md`.
8. Tell the user the `plan.html` path. Do not paste the full intent JSON.

Wrapper: `scripts/render-plan-html.js` calls `devkit plan --render`.
