# Claude Code adapter

Load this plugin:

```
claude --plugin-dir packages/plugin
```

`--plugin-dir packages/plugin` is not enough.

The agent must find `devkit` on PATH.

`--plugin-dir` does not add `packages/plugin/dist/cli.js` to PATH.

Skills spawn `devkit` for render, coordinator, and gates. Those calls fail if `devkit` is missing.

Install the CLI:

```
pnpm add -D @coredevkit/plugin
```

Then put the `devkit` bin on PATH.

MCP: `.mcp.json` runs `devkit mcp`. Tool names stay the platform names. There is no second server.

Restart the harness after install. Platform MCP `listChanged` is false.
