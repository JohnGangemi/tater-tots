---
name: using-coredevkit
description: >
  Use CoreDevKit platform tools when they are available.
  Triggers: coredevkit, code graph, playbook, evidence_check,
  adversarial_review, verification gate.
---

# Using CoreDevKit platform

Prefer `graph_search`, `graph_symbol`, and `graph_impact` before walking
the repository.

Prefer `playbook_lookup` for test, build, and lint commands.

Call `evidence_check` before claiming done when verification is not off.

Do not edit files under plugin or marketplace directories for skill
overrides. Use `tune_status` / `tune_accept`.

If a tool is missing, continue the user task. Do not stop the session.
