# @coredevkit/plugin

This package adds plan, implement, debug, review, finish, and issue-to-pr commands to `devkit`.

It depends on `@coredevkit/platform`. It does not hide platform MCP tools.

## Install

```
pnpm add -D @coredevkit/plugin
```

Put `devkit` on PATH. Skills call `devkit`.

Claude `--plugin-dir packages/plugin` does not put `devkit` on PATH.

## Claude Code

Load the plugin from this directory:

```
claude --plugin-dir packages/plugin
```

Also install the CLI so `devkit` is on PATH. See `adapters/claude-code/README.md`.

MCP tools come from `devkit mcp`. This plugin does not wrap or rename those tools.

## Generic harness

Copy `adapters/generic/mcp.json` into the MCP config.

Copy skills with `adapters/generic/skills-copy.md`.

## In-repo plan files

Default plan files stay in user data. If you set `--plan` to a folder in the git tree, add `adapters/generic/gitignore.fragment` to `.gitignore`.
