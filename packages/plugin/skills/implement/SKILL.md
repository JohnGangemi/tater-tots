---
name: implement
description: >
  Use when the user says implement, resume, continue the plan, or
  `devkit implement`. Resumes the exact coordinator step and marks done
  with an evidence gate.
  Triggers: implement, resume, continue the plan, devkit implement.
---

Before the steps, if you can run `devkit skill show implement`, obey any
## Personal override section after the shipped steps.

# Implement

Call platform tools by logical names: `graph_search`, `graph_symbol`,
`graph_impact`, `playbook_lookup`, `evidence_check`, `adversarial_review`.
If a tool is missing, fail this workflow. Do not walk the repository when
graph tools respond, including zero hits.

Implement reads the coordinator and `plan.md`. It does not read
`plan.intent.json` for step work.

## Steps

1. If the packet says `stack.enabled` and the current item is not
   `checked_out`, run `devkit stack publish` before any coder packet.
   Do not implement on `main`.
2. If the packet or CLI says wait for `--accept-patch`, run
   `devkit implement --accept-patch` only after the user agrees.
3. Run `devkit implement` (add `--step <id>` only to jump to an existing
   id on the current stack item). Use the JSON packet: `resume_step_id`,
   `dispatch.agent`, `allowed_paths`, playbook hints, graph hints.
   When verification is `full` and a trigger matches, the CLI prefix
   runs the adversarial checkpoint on packet and on `--mark done`.
   On `BLOCK`, stop. Do not dispatch coder. Do not `--mark done`.
4. If `blocking open questions` appear, stop. Do not dispatch. Do not
   `--mark done`. After the user resolves questions in intent, run
   `devkit plan --start-coordinator` without `--replace`, then resume.
5. Dispatch the configured coder (packet `dispatch.agent`) for only the
   current item `step_ids`. Stay inside `allowed_paths`. Dispatch tester
   when the step needs evidence. Store only a short summary.
6. Run `devkit implement --mark done` (evidence runs inside the CLI when
   the level is `light` or `full`). Prefer `--evidence-command` or
   `--evidence-purpose`. Stop on blocked. Resume the exact step in that
   item. Do not `--mark done` onto another stack item.
7. When the item steps are terminal, run `devkit stack publish` to open
   the PR.

`--mark done` maps fail / no_command / denied to exit 2, and evidence
error to exit 3. Level `off` skips evidence.
