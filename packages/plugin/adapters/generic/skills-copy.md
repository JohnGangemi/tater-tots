# Copy plugin skills

Use this when the harness is not Claude Code.

1. Install `@coredevkit/plugin` so `devkit` is on PATH.
2. Copy `adapters/generic/mcp.json` into the harness MCP config.
3. Copy each folder in `skills/` into the harness skill path.
4. Copy each file in `agents/` into the harness agent path.

Do not rename MCP tools. The snippet starts `devkit mcp`. Logical names have no prefix.

| Logical name         | Example wire name                     |
| -------------------- | ------------------------------------- |
| `graph_search`       | `mcp__coredevkit__graph_search`       |
| `graph_symbol`       | `mcp__coredevkit__graph_symbol`       |
| `graph_impact`       | `mcp__coredevkit__graph_impact`       |
| `playbook_lookup`    | `mcp__coredevkit__playbook_lookup`    |
| `playbook_record`    | `mcp__coredevkit__playbook_record`    |
| `evidence_check`     | `mcp__coredevkit__evidence_check`     |
| `adversarial_review` | `mcp__coredevkit__adversarial_review` |
| `tune_status`        | `mcp__coredevkit__tune_status`        |
| `tune_accept`        | `mcp__coredevkit__tune_accept`        |
| `tune_reject`        | `mcp__coredevkit__tune_reject`        |

A harness may add a prefix. Skills still use the logical name.

`--plugin-dir` is Claude only. Other harnesses still need `devkit` on PATH.
