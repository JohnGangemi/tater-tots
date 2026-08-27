---
name: adversarial-checkpoint
description: >
  Use when Implement or Issue-to-PR needs a checkpoint, or the user
  asks for adversarial review. Runs the platform verdict on plan.md
  before implement. Never implements source.
  Triggers: adversarial-checkpoint, adversarial review, checkpoint,
  implement full, issue-to-pr gate.
---

Before the steps, if you can run `devkit skill show adversarial-checkpoint`,
obey any ## Personal override section after the shipped steps.

# Adversarial checkpoint

Call platform tools by logical names: `graph_search`, `graph_symbol`,
`graph_impact`, `playbook_lookup`, `adversarial_review`. If a tool is
missing, fail this workflow. Do not walk the repository when graph
tools respond, including zero hits.

The CLI prefix on `devkit implement` (packet and `--mark done`) runs
this gate. `source: issue-to-pr` uses the same gate. Do not copy it.

The platform tool is the verdict. The plugin computes `eligible`.
Do not implement.

## When it runs

Run only when all of these are true:

- `resolved_level` is `full`
- a trigger matches: step count ≥ `min_steps_for_adversarial` (default 4),
  or `stack.enabled`, or `source` is `issue-to-pr`
- coordinator `adversarial.status` is not `passed`

Do not re-run a passed checkpoint. Do not re-run the checker in the
same `session_id`.

## Steps

1. Dispatch the configured checker (`verification.adversarial_subagent`,
   default `adversarial-checker`). The agent is read-only.
2. Call `adversarial_review` with `plan_path` set to the absolute
   `plan.md` (`agent_plan` in the packet). Prefer user-data
   `DEVKIT_HOME/plans/<repo-id>/<worktree-hash>/plan.md`.
3. Use the platform verdict. Compute `eligible` as:
   `tag` is `patch-plan`, `evidence_type` is not `none`, `patch` is a
   non-empty string.
4. On `PASS`, the coordinator status is `passed`. Continue implement.
5. On `BLOCK`, the coordinator status is `blocked`. Exit 2. Do not
   start implement. Do not `--mark done`. Do not dispatch coder.
6. On `PATCH` with `auto_patch` true: apply only eligible findings to
   `plan.md` (first exact heading or whole-line match; backup
   `plan.md.bak` once per session). Then mark `passed`. Do not call
   the checker again in this session.
7. On `PATCH` with `auto_patch` false: do not edit `plan.md`. Do not
   mark `passed`. Print findings. Wait for the user. Next
   `devkit implement` without `--accept-patch` exits 2.
   `devkit implement --accept-patch` sets `passed` without a re-run,
   then implement may start.

Never write `plan.intent.json` from this skill. Never implement source.
