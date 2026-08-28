# plan.md contract

Agents execute this file. Implement and `adversarial_review` read it.
Do not drop numbered steps to shorten the file.

```markdown
# <title>

Goal: <one paragraph>

## Steps

1. **S1: Add coordinator store** — paths `packages/plugin/src/lib/coordinator/store.ts`. Evidence: `pnpm --filter @coredevkit/plugin test`.
2. **S2: Next step** — paths `packages/plugin/src/lib/plan/intent.ts`. Stack: `A`

## Evidence

Default: `pnpm --filter @coredevkit/plugin test`

## Stack

none
```

## Rules

- One numbered step per coordinator step
- Optional explicit id: `1. **S1: Title**` or `1. Title`
- If no explicit id, the parser assigns `S1`…`Sn` in order
- Backtick paths become `allowed_paths`
- `Evidence: \`command\`` or a fenced `bash` block on that step sets the
  evidence command
- `Stack: <stack_id>` optional on a step
- `## Stack` may list dependent tasks; `none` means no stack
