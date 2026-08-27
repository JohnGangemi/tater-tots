---
name: issue-to-pr
description: >
  Use when the user says issue to PR, close issue N, or
  `devkit issue-to-pr`. Reads a GitHub issue, writes a statement of
  work in user-data, refines a plan until --accept-plan, then
  implements and publishes a pull request or stack.
  Triggers: issue to PR, close issue, issue-to-pr, devkit issue-to-pr.
---

Before the steps, if you can run `devkit skill show issue-to-pr`, obey any
## Personal override section after the shipped steps.

# Issue to pull request

Call platform tools by logical names: `graph_search`, `graph_symbol`,
`graph_impact`, `playbook_lookup`, `evidence_check`, `adversarial_review`.
If a tool is missing, fail this workflow. Do not walk the repository when
graph tools respond, including zero hits.

The CLI is the driver. Do not spawn a shell for `git` or `gh`.

## Steps

1. Run `devkit issue-to-pr --issue <n>` (a GitHub issue URL is also
   valid). The CLI runs `gh issue view` as argv, timeout 60s. It writes
   the statement of work to user-data
   `progress/<repo-id>/<worktree-hash>.sow.md` (mode 0600). Never write
   the raw issue body into `--plan` or the git repository.
2. Use the JSON packet. While `pipeline_phase` is `draft_plan` or
   `refine`, follow `writing-plans`. Read the SoW file. Write
   `plan.intent.json` and `plan.md` in `plan_dir`. Do not auto-continue
   after one refine pass.
3. Stop until the user runs `devkit issue-to-pr --accept-plan`. That
   flag is the consensus signal. It starts the coordinator with
   `source: issue-to-pr` so the adversarial checkpoint can match.
4. After `--accept-plan`, if `stack.enabled` is true, loop:
   - `devkit issue-to-pr --publish` or `devkit stack publish` (pauses at
     `checked_out`; tests-complete does not block this first checkout)
   - implement only the current item (code, review, test) with
     `devkit implement`
   - `devkit issue-to-pr --publish` to open that item PR
   Repeat until every item is `pr_created` (or local `pushed` if `gh`
   is missing). Do not implement the whole plan on one branch first.
5. If `stack.enabled` is false: implement all steps, then branch review
   (`devkit review`), then security review (`graph_impact` on changed
   files, read-only reviewer), then tests, then
   `devkit issue-to-pr --publish` for one `gh pr create`.
6. If `gh` is missing on publish: keep local branches, skip PR create,
   exit 0. Do not fail only because `gh` is missing.

See `references/pipeline.md`.
