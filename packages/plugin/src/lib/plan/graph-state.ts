import { existsSync, readFileSync } from "node:fs";
import type { PlatformContext } from "@coredevkit/platform";
import { PluginError } from "../errors.js";

export type PacketGraph = "ready" | "degraded" | "missing" | "unknown";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read mapping only. Do not walk the repo and do not spawn CBM. */
export function graphStateFromMapping(ctx: PlatformContext): PacketGraph {
  const file = ctx.paths.cbmProjectFile;
  if (!existsSync(file)) {
    return "missing";
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isPlainObject(raw) ||
      raw.version !== 1 ||
      typeof raw.cbm_project !== "string" ||
      raw.cbm_project.length === 0
    ) {
      return "missing";
    }
    if (raw.last_status === "degraded") {
      return "degraded";
    }
    if (raw.last_status === "ready") {
      return "ready";
    }
    return "unknown";
  } catch {
    return "missing";
  }
}

export function requireGraphMapping(ctx: PlatformContext): PacketGraph {
  const graph = graphStateFromMapping(ctx);
  if (graph === "missing") {
    throw new PluginError("io", "Graph mapping missing", "run devkit init");
  }
  return graph;
}
