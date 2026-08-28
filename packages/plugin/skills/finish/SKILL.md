---
name: finish
description: >
  Use when wrapping up a plan. Summarizes remaining steps, HTML path,
  stack PR URLs, and evidence.
  Triggers: finish, wrap up, remaining steps, skip remaining, devkit finish.
---

Before the steps, if you can run `devkit skill show finish`, obey any
## Personal override section after the shipped steps.

# Finish

Call platform tools by logical names: `evidence_check`. If a tool is
missing, fail this workflow.

## Steps

1. Run `devkit finish`. Read remaining step ids, HTML path, stack PR
   URLs, and adversarial status when present.
2. If verification is `light` or `full`, the CLI runs `evidence_check`
   with purpose `test`. fail / no_command / denied exit 2. error exits 3.
   Do not claim done on those verdicts.
3. Print the HTML path. Print stack PR URLs when present.
4. Run `devkit finish --skip-remaining` only with user intent. That
   marks pending steps as `skipped`. Do not skip without the user.
5. If adversarial status is present on the coordinator, print it.
   If it is absent, continue.
