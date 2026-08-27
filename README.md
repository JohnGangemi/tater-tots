# CoreDevKit

CoreDevKit is a local toolkit for coding agents.

It gives agents a code map, a memory of commands that already worked, and a check before they say “done.” It also ships a workflow pack: plan, implement, debug, review, finish, and issue-to-PR.

This git repository is `tater-tots`. The product name is CoreDevKit.

**Status:** Platform code is in `packages/platform`. Plugin code is not in this repository yet. It will land in `packages/plugin`.

## What this is

Think of two boxes:

1. **Platform** — a shared toolbox. Any skill can use it. A raw agent session can use it too.
2. **Plugin** — a set of workflows that **call** that toolbox. It does not hide the tools.

The platform must work in three session shapes:

1. A CoreDevKit skill is running.
2. A third-party skill is running (for example Superpowers).
3. No skill is loaded (raw agent session).

| Layer | Package | Job |
|-------|---------|-----|
| Platform | `@coredevkit/platform` | Shared services any skill can call |
| Plugin | `@coredevkit/plugin` | Workflows that call those services |

There is one user-facing `devkit` binary. Install the plugin for the full toolkit. The plugin depends on the platform. A platform-only install still works for foreign skills.

If `@coredevkit/platform` is missing, plugin commands print one short line and exit `1`. They do not walk the whole tree.

## What this is not

- It is not a cloud service.
- It does not send telemetry or token logs.
- It does not edit third-party `SKILL.md` files.
- It does not inject a large session skill body.
- It does not force other installed skills to use these workflows.
- It does not run `codebase-memory-mcp install`.
- There is no `devkit install` command in v1.

## Who does what

| Platform | Plugin |
|----------|--------|
| MCP tools, `devkit mcp`, optional hooks | Skills: `writing-plans`, `implement`, `issue-to-pr`, and the rest |
| Code graph **client** over [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Dual plan files: `plan.intent.json`, `plan.md`, `plan.html` |
| Personal playbook (compressed, not committed) | Plan coordinator with exact-step resume |
| `evidence_check` and `adversarial_review` **tools** | Skills that call those tools and record the result |
| Tune propose + personal override **store** | Override **load**; workflow commands |
| `devkit init`, `playbook`, `tune` | `devkit plan`, `implement`, `debug`, `review`, `finish`, `issue-to-pr`, `stack publish` |

The plugin must call platform tools. It must not hide them.

## How you talk to it

Three surfaces share one library:

| Surface | How | Notes |
|---------|-----|-------|
| CLI | `devkit <command>` | Works without MCP |
| MCP | `devkit mcp` (stdio) | Server name `coredevkit`. Logical tool names have no prefix |
| Hooks (optional) | `devkit hook <event>` | Fail open. SessionStart is a short pointer |

If hooks are missing, MCP and CLI still work.

## Platform services

### Code graph

`devkit init` indexes the current repository.

Skills then call `graph_search`, `graph_symbol`, and `graph_impact`. They should not walk the whole tree to answer “what calls this?”

Graph data stays on the local machine (the CBM cache). Default index mode is `moderate`. Modes: `fast`, `moderate`, `full`.

CoreDevKit wraps the CBM CLI. It does not start the CBM daemon. It does not run `codebase-memory-mcp install`. If no CBM binary is on PATH, `devkit init` may fetch a pinned release only after you type `y` in a TTY.

### Playbook

The playbook is a personal list of test, build, and lint commands that already proved useful.

- It is compressed. It is not user-editable. It is not committed.
- One file is shared across worktrees of the same origin.
- It stores only real command runs. It never stores LLM lessons.
- The platform never asks which facts to keep.
- If secret redaction is uncertain, it drops the entry.

Look up commands with `playbook_lookup` or `devkit playbook show`.

### Evidence and adversarial review

- `evidence_check` runs a local command (or a playbook hit). It returns pass or fail plus a short tail.
- `adversarial_review` reads a plan file, the files, the graph, and the playbook. v1 is local and repeatable. It does **not** edit the plan. The caller decides whether to patch.

Default verification level is `light`. Override per run with `--verification off|light|full`.

### Tune

The platform may propose a short personal skill override from repeated facts only.

- `auto_accept` default is `false`.
- Accepted text lives under user-data, keyed by repo and skill name.
- It never writes into plugin or marketplace directories.
- Revert with `devkit tune revert <skill>`.

### Thin skill: `using-coredevkit`

This skill is not a workflow. It tells other skills:

- Prefer graph tools before a tree walk.
- Prefer `playbook_lookup` for test, build, and lint.
- Call `evidence_check` before claiming done when verification is not `off`.
- If a tool is missing, continue the user task.

## Plugin workflows

The plugin adds workflow commands beside the platform CLI. Skills and sub-agents do the LLM work. `devkit` is a helper. It validates, renders HTML, updates the coordinator, and runs gates. It spawns `git` and `gh`. It does not call a model.

### Dual plan files

Default location (not the git repo):

```
<DEVKIT_HOME>/plans/<repo-id>/<worktree-hash>/
  plan.intent.json
  plan.md
  plan.html
```

| File | Who uses it |
|------|-------------|
| `plan.intent.json` | Source of truth for the design. HTML is rendered from this file only |
| `plan.md` | Agents execute this. Implement and adversarial review read it |
| `plan.html` | Humans read this. System, light, and dark themes |

Do not convert `plan.md` to HTML. HTML follows the intent file.

### Coordinator

Plan and Implement share one coordinator YAML per worktree. The file records steps, status, evidence, stack data, and adversarial status. It also records the exact resume step. If a session dies, the next run continues at that step.

### Skills

| Skill | When |
|-------|------|
| `writing-plans` | The user says plan, design, or `devkit plan` |
| `implement` | The user says implement, resume, or `devkit implement` |
| `debug` | A test or runtime fails |
| `review` | The user asks to review a branch, diff, or step |
| `finish` | Wrap-up: remaining steps, evidence, HTML path, PR URLs |
| `issue-to-pr` | The user says issue to PR, or `devkit issue-to-pr` |
| `adversarial-checkpoint` | A large plan needs a checkpoint |

Plugin skills require the platform. They do not continue without graph the way `using-coredevkit` does.

Claude skill names look like `/coredevkit:writing-plans`.

### Sub-agent roles

Default roles: Explorer, Coder, Tester, Reviewer, Adversarial Checker, Plan Designer.

You may swap a role name in config. Plan Designer writes intent JSON only. Adversarial Checker is read-only. It does not implement.

### Stacked PRs and Issue-to-PR

Dependent work uses GitHub stacked PRs. The driver is `devkit stack publish`.

The rule is: publish (checkout) → implement **only that item** → publish (open the PR). Do not implement every item on `main` first.

If `gh` is missing, CoreDevKit still creates local branches, commits, and pushes when a remote works. It skips `gh pr create`. It does not fail only because `gh` is missing.

Issue-to-PR: read the GitHub issue, draft a plan, wait for `--accept-plan`, then implement and publish.

### Gates

- Verification `off`: skip evidence and adversarial review.
- `light` and `full`: `evidence_check` before a coordinator step is `done`.
- `full` plus a trigger: adversarial checkpoint. Do not re-run a checkpoint that already passed. Do not start Implement on `BLOCK`.

## First run

Platform commands work after you build `packages/platform`. Plugin commands land with `@coredevkit/plugin`.

Need:

- Node.js 20 or later
- pnpm (this repo is a pnpm workspace)
- `devkit` on `PATH` (Claude `--plugin-dir` does **not** put the binary on PATH)
- Optional: `git` and `gh` for stacks and Issue-to-PR

Toolkit (workflows + platform):

```bash
pnpm add -D @coredevkit/plugin
```

Platform only (foreign skills, no workflows):

```bash
pnpm add -D @coredevkit/platform
```

In the target repository:

```bash
devkit init
```

Register the MCP server:

```json
{
  "mcpServers": {
    "coredevkit": {
      "command": "devkit",
      "args": ["mcp"]
    }
  }
}
```

Restart the harness after install.

Optional Claude plugin files live with the plugin package: `plugin.json` and `.claude-plugin/plugin.json`. `.mcp.json` points at the same `devkit mcp` command. That **exposes** platform tools. It does not wrap or rename them.

## Commands

Global flags that always work: `--path`, `--verification off|light|full`, `--config`. Plugin also accepts `--plan`.

Default: `cwd` is the repo. Verification default is `light`. `--verification` does not write the config file.

### Platform

| Command | Purpose |
|---------|---------|
| `devkit init [--mode fast\|moderate\|full]` | Index the repo graph |
| `devkit playbook show` | Print recent playbook hits |
| `devkit playbook stats` | Counts only |
| `devkit tune status` | Pending proposal ids |
| `devkit tune show <id>` | One proposal |
| `devkit tune accept <id>` | Write a personal override |
| `devkit tune reject <id>` | Mark rejected |
| `devkit tune revert <skill>` | Remove the override |
| `devkit mcp` | MCP server (stdio) |
| `devkit hook <session-start\|post-tool-use\|stop>` | Optional harness hook |

### Plugin (same binary)

| Command | Purpose |
|---------|---------|
| `devkit plan` | Packet for writing-plans. Does not write the plan files |
| `devkit plan --render` | Write `plan.html` from existing intent |
| `devkit plan --start-coordinator` | Create or merge the coordinator from `plan.md` |
| `devkit implement` | Resume packet and/or mark a step |
| `devkit stack publish` | Checkout the next stack item, or open its PR |
| `devkit debug` | Graph + playbook packet for a failure |
| `devkit review` | Impact packet on a diff or path |
| `devkit finish` | Remaining steps, evidence, HTML path, stack URLs |
| `devkit issue-to-pr` | Issue → plan → PR or stack |
| `devkit skill show <name>` | Shipped skill body plus personal override |

`devkit plan --goal` only fills the packet. Skills write `plan.intent.json` and `plan.md`.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success. Hooks also exit 0 (fail open) |
| 1 | Usage, config, or platform missing |
| 2 | Evidence gate failed, adversarial `BLOCK`, or wait for accept |
| 3 | Graph or tool failure |

## MCP tools

Logical names are stable. A harness may add a prefix such as `mcp__coredevkit__graph_search`. Adapters must not rename the logical names.

| Tool | Purpose |
|------|---------|
| `graph_search` | Find symbols by query |
| `graph_symbol` | Definitions and refs for a name |
| `graph_impact` | Callers and dependents for a path or symbol |
| `playbook_lookup` | Top matching commands (not the full file) |
| `playbook_record` | For hooks. Skills should not need this |
| `evidence_check` | Run a command or playbook hit; pass/fail + short tail |
| `adversarial_review` | Tagged findings on a plan path |
| `tune_status` | Pending proposal ids |
| `tune_accept` | Accept one proposal into user-data |
| `tune_reject` | Reject one proposal |

`tune revert` is CLI-only.

## Data on your machine

User-data root is `DEVKIT_HOME`:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/devkit` |
| Linux | `$XDG_DATA_HOME/devkit` or `~/.local/share/devkit` |
| Windows | `%APPDATA%\devkit` |

Set `DEVKIT_DATA_DIR` to replace the OS data root (tests and CI).

Stored under `DEVKIT_HOME` (directories `0700`, files `0600`):

- Playbooks, keyed by repo-id
- Personal skill overrides
- Graph mapping (CBM project name ↔ repo-id)
- Coordinator YAML and plan files (plugin)
- Local JSONL logs

Repo-id is a short hash of the normalized git origin URL. Worktrees of the same origin share one playbook. Each worktree has its own coordinator and plan directory.

The graph SQLite files stay in the CBM cache (`~/.cache/codebase-memory-mcp/` by default). They are not CoreDevKit user-data.

Playbooks, plans, and progress are not committed. If you put `--plan` inside the repo, gitignore those files yourself.

## Privacy

- No telemetry. No token counts. No model names in CoreDevKit logs.
- Nothing is uploaded.
- The only optional network call is a pinned CBM download from GitHub Releases after you type `y`.
- Commands in logs pass the same redactor as the playbook.
- Hooks fail open so they do not block a foreign skill. Shipped `platform.stop_blocking` is `false`.

## Configuration

Merge order (highest wins): CLI flags → env → `--config` file → project `.devkit/config.yaml` → user config → shipped defaults.

Arrays replace. Objects deep-merge. Unknown keys are ignored.

Shipped defaults that matter:

```yaml
verification:
  level: light
tuning:
  auto_accept: false
platform:
  stop_blocking: false
  graph:
    index_mode: moderate
```

User config: `DEVKIT_HOME/config.yaml` on macOS and Windows. On Linux it is `$XDG_CONFIG_HOME/devkit/config.yaml` (or `~/.config/devkit/config.yaml`).

Project file (optional): `<repo>/.devkit/config.yaml`. Prefer to gitignore `.devkit/`.

## This repository

Target layout:

```
tater-tots/
  packages/
    platform/    # @coredevkit/platform
    plugin/      # @coredevkit/plugin
```

TypeScript ESM. Node.js 20+. pnpm workspace.

```bash
pnpm install
pnpm --filter @coredevkit/platform build
pnpm --filter @coredevkit/platform test
pnpm --filter @coredevkit/platform typecheck
```

### Design documents

Requirements documents are the source of truth. Implementation documents are the build contract. This README does not replace them.

| File | Role |
|------|------|
| `CoreDevKit_Platform_Requirements_and_Design.md` | Platform requirements |
| `CoreDevKit_Platform_Implementation_Design.md` | Platform build contract |
| `CoreDevKit_Plugin_Requirements_and_Design.md` | Plugin requirements |
| `CoreDevKit_Plugin_Implementation_Design.md` | Plugin build contract |

## License

MIT. See [LICENSE](LICENSE).
