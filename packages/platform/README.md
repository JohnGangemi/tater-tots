# CoreDevKit platform

This package is a local service layer for coding agents.

Other skills can call the tools. The tools work if no CoreDevKit skill is loaded.

## MCP

Add this snippet to the agent MCP config:

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

The server name is `coredevkit`. Logical tool names have no prefix.

Hooks are optional. MCP and the CLI still work without hooks.

## Init

Run `devkit init` in the git repository.

The command prepares a local code graph and the playbook path.

## CBM binary

The graph engine is `codebase-memory-mcp` (CBM), version 0.10.8 or later.

The platform uses the first CBM binary it finds:

1. Config `platform.graph.binary`
2. Environment `DEVKIT_CBM_BINARY`
3. CBM command path in MCP config
4. `PATH`
5. `$HOME/.local/bin/codebase-memory-mcp`
6. `DEVKIT_HOME/bin/codebase-memory-mcp`

If none of these is version 0.10.8 or later:

- Terminal (TTY): `devkit init` shows the pinned URL, version, SHA-256, and dest. Type `y` to fetch the binary into `DEVKIT_HOME/bin`. The default is `N`.
- Not a terminal: no fetch. The command exits 3.

MCP tools and hooks never fetch CBM. Dest is never the repository.

Do not run `codebase-memory-mcp install`.

## Skill

A thin skill is in `skills/using-coredevkit/SKILL.md`.

It is not a workflow. You can copy it into a harness so the agent prefers these tools.
