---
name: review
description: >
  Use when the user asks to review a branch, diff, or step. Maps git
  diff names with graph_impact and dispatches the reviewer.
  Triggers: review, review branch, review diff, review step, devkit review.
---

Before the steps, if you can run `devkit skill show review`, obey any
## Personal override section after the shipped steps.

# Review

Call platform tools by logical names: `graph_impact`, `graph_symbol`.
If a tool is missing, fail this workflow. Do not walk the repository
when graph tools respond, including zero hits.

## Steps

1. Run `devkit review` (add `--scope <path>` to limit to one path).
   The CLI runs `git diff --name-only` and `git diff --cached --name-only`
   as argv. It does not walk the tree.
2. The CLI calls `graph_impact` for each path (cap 20). Use those
   graph hints. Do not glob.
3. Dispatch the configured reviewer (packet `dispatch.agent`).
   Read-only. Do not implement.
4. Return a short summary. Do not mark coordinator `done`.
