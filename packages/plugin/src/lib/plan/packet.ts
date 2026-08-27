import type { StackPhase } from "../coordinator/types.js";
import type { SubagentRole } from "../plugin-config.js";
import type { PacketGraph } from "./graph-state.js";

export type SubagentPacket = {
  role: SubagentRole;
  agent: string;
  goal: string;
  step_id: string | null;
  allowed_paths: string[];
  playbook_hints: { purpose: string; command: string }[];
  graph_hints: { query: string; path?: string }[];
  constraints: string[];
};

export type RunPacket = {
  command: string;
  repo_id: string;
  worktree_hash: string;
  resolved_level: "off" | "light" | "full";
  graph: PacketGraph;
  plan_dir: string | null;
  html_path: string | null;
  agent_plan: string | null;
  resume_step_id: string | null;
  stack_phase: StackPhase | null;
  stack_branch: string | null;
  adversarial_status: "skipped" | "passed" | "blocked" | null;
  dispatch: { role: SubagentRole; agent: string } | null;
  packet: SubagentPacket | null;
  skill: string;
  override_loaded: boolean;
  hint: string;
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function graphHintsFromText(text: string): { query: string }[] {
  const seen = new Set<string>();
  const out: { query: string }[] = [];
  for (const word of text.split(/\s+/)) {
    const token = word.replace(/[^A-Za-z0-9_.]+/g, "");
    if (!IDENTIFIER_RE.test(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push({ query: token });
    if (out.length >= 5) {
      break;
    }
  }
  return out;
}

export function htmlHint(htmlPath: string): string {
  return `Open ${htmlPath} for humans. Agents use plan.md.`;
}
