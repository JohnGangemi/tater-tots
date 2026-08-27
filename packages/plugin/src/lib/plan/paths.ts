import { isAbsolute, join } from "node:path";
import type { PlatformContext } from "@coredevkit/platform";
import type { PluginConfig } from "../plugin-config.js";
import { worktreeHash } from "../worktree.js";

export const PLAN_INTENT_FILE = "plan.intent.json";
export const PLAN_MD_FILE = "plan.md";
export const PLAN_HTML_FILE = "plan.html";

export function resolvePlanDir(
  ctx: PlatformContext,
  cfg: PluginConfig,
  worktree_hash?: string,
): string {
  const hash = worktree_hash ?? worktreeHash(ctx.repoPath).worktree_hash;
  const override = cfg.plugin.plan_dir?.trim();
  if (override) {
    return isAbsolute(override) ? override : join(ctx.repoPath, override);
  }
  return join(ctx.paths.plansDir, hash);
}

export function planFilePaths(planDir: string): {
  planDir: string;
  intentPath: string;
  agentPlan: string;
  htmlPath: string;
} {
  return {
    planDir,
    intentPath: join(planDir, PLAN_INTENT_FILE),
    agentPlan: join(planDir, PLAN_MD_FILE),
    htmlPath: join(planDir, PLAN_HTML_FILE),
  };
}
