import type {
  LookupIn,
  LookupOut,
  PlatformContext,
} from "@coredevkit/platform";
import type { CoordinatorStep } from "../coordinator/types.js";
import type { PluginConfig } from "../plugin-config.js";
import { graphHintsFromText, type SubagentPacket } from "../plan/packet.js";
import { resolveSubagent } from "./resolve.js";

export type PlaybookLookupFn = (
  ctx: PlatformContext,
  q: LookupIn,
) => Promise<LookupOut>;

export async function buildPacket(
  ctx: PlatformContext,
  cfg: PluginConfig,
  step: CoordinatorStep,
  playbookLookup: PlaybookLookupFn,
): Promise<SubagentPacket> {
  const role = "coder" as const;
  const agent = resolveSubagent(cfg, role);
  const lookup = await playbookLookup(ctx, { purpose: "test" });
  const playbook_hints = lookup.commands.slice(0, 5).map((hit) => ({
    purpose: hit.purpose_tags[0] ?? "test",
    command: hit.command,
  }));
  return {
    role,
    agent,
    goal: step.step_title,
    step_id: step.id,
    allowed_paths: step.allowed_paths.slice(),
    playbook_hints,
    graph_hints: graphHintsFromText(step.step_title),
    constraints: [
      "Stay inside allowed_paths.",
      "Do not walk the repository when graph tools respond.",
    ],
  };
}

export type { SubagentPacket };
