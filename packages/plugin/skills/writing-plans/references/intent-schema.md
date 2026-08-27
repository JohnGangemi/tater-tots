# Intent schema

Plugin-owned JSON. File name: `plan.intent.json`.

## Required scalars

- `version`: `1`
- `title`, `summary`, `goal`, `agent_plan` (absolute path to `plan.md`)
- `theme_default`: `system` | `light` | `dark` (default `system` if omitted)

## Always-present arrays

May be empty, but the keys must exist:

`non_goals`, `constraints`, `assumptions`, `open_questions`, `components`,
`processes`, `sequences`, `stack`, `risks`.

## Open questions

Each item: `id`, `ask`, `why_it_matters`, `blocks`, `options`, `status`,
`answer`.

- `status`: `open` | `resolved` | `dropped`
- `open` requires `answer` null
- `resolved` requires a non-empty `answer`
- Ids must be unique
- Resolved questions stay in the file and also become assumptions

## Processes

- `complete` is true if and only if `steps.length >= 1` and every
  `steps[].required` is true
- Reject `complete: true` when steps are empty or any required step is false
- Each step: `id`, `title`, `detail`, `required`
- `summary` max 500 chars, `goal` max 2000, step `detail` max 2000
- No implementation fences (```) unless `plugin.html_code_blocks` is true

## Sequences

Optional highlight. When `process_id` is set, every `step_ids[]` must be
an id in that process.

## Stack

Dependent GitHub PRs. `depends_on` must refer to other stack ids. No cycles.
`base` is a stack id or `@default`.

## Risks

`id`, `claim`, `mitigation`, `severity` (`low` | `medium` | `high`).

See `intent.schema.json` for the machine schema.
