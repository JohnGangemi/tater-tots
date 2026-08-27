import type { PluginConfig, SubagentRole } from "../plugin-config.js";

export function resolveSubagent(cfg: PluginConfig, role: SubagentRole): string {
  return cfg.subagents[role];
}
