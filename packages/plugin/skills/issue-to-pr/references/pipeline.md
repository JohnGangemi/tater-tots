# Issue-to-PR pipeline

CLI: `devkit issue-to-pr [--issue <n|url>] [--accept-plan] [--publish]`

## Phases

1. `read_issue` — `gh issue view <n> --json number,title,body,labels,url,comments`
   (argv, `shell: false`, timeout 60s). Log the issue number only.
2. `sow` — write `join(progressDir, worktreeHash + ".sow.md")` mode 0600.
   Never write the raw issue body into `--plan` or the git repo.
3. `draft_plan` / `refine` — writing-plans until `--accept-plan`.
   Do not auto-continue after one refine pass.
4. `--accept-plan` — start coordinator `source: issue-to-pr`.
5. Stacked (`stack.enabled`): loop `stack publish` (pause at
   `checked_out`) → implement current item → `stack publish` (PR)
   until `pr_created`. Tests-complete does not block the first checkout.
6. Single PR (`stack.enabled` false): implement all → branch review →
   security review → tests (`evidence_check` purpose test, then build,
   then lint) → one `gh pr create`.
7. `gh` missing on publish: local branches only, skip `gh pr create`,
   exit 0.
