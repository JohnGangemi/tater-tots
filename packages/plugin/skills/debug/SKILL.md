---
name: debug
description: >
  Use when a test or runtime fails. Builds a graph and playbook packet
  for the failure, then dispatches explorer and coder.
  Triggers: debug, failure, test failed, runtime error, devkit debug.
---

Before the steps, if you can run `devkit skill show debug`, obey any
## Personal override section after the shipped steps.

# Debug

Call platform tools by logical names: `graph_search`, `graph_symbol`,
`graph_impact`, `playbook_lookup`, `evidence_check`. If a tool is missing,
fail this workflow. Do not walk the repository when graph tools respond,
including zero hits.

Coordinator is optional.

## Steps

1. Run `devkit debug --query "<failure>"`. Use the JSON packet: graph
   hints, playbook hints, and dispatch explorer.
2. Call `graph_search` / `graph_symbol` / `graph_impact` first. Stop the
   explore path when they respond.
3. Call `playbook_lookup` for command hints. Call `evidence_check` to
   reproduce the failure.
4. Dispatch explorer from packet `dispatch.agent`. Then dispatch coder
   (config `subagents.coder`) and tester when a test must run.
5. Do not glob the tree. Do not start a full-repo explore loop.
6. Return a short summary. Do not mark coordinator `done`.
