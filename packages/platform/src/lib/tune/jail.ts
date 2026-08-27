import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";
import { PROPOSAL_ID_MAX, PROPOSAL_ID_RE } from "./types.js";

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;

const FORBIDDEN_DIR = new Set(["plugins", "marketplace", "node_modules"]);

export function isValidSkillName(skill: string): boolean {
  return skill.length > 0 && skill.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(skill);
}

export function isValidProposalId(id: string): boolean {
  return id.length > 0 && id.length <= PROPOSAL_ID_MAX && PROPOSAL_ID_RE.test(id);
}

function abs(p: string): string {
  return resolve(p);
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return abs(p);
  }
}

function firstExisting(p: string): string {
  let cur = abs(p);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) {
      return cur;
    }
    cur = parent;
  }
  return cur;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(abs(root), abs(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Directory names only. A file such as plugins.override.md is not a plugin dir. */
export function hasForbiddenDir(p: string): boolean {
  const segs = p.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  const last = segs[segs.length - 1];
  const dirs = last !== undefined && last.includes(".") ? segs.slice(0, -1) : segs;
  for (let i = 0; i < dirs.length; i++) {
    const seg = dirs[i];
    if (seg === undefined) {
      continue;
    }
    const folded = seg.toLowerCase();
    if (FORBIDDEN_DIR.has(folded)) {
      return true;
    }
    if (folded === ".claude" && dirs[i + 1]?.toLowerCase() === "plugins") {
      return true;
    }
  }
  return false;
}

function deny(): never {
  throw new PlatformError(
    "denied",
    "Override path is not allowed",
    "Writes stay under DEVKIT_HOME/overrides",
  );
}

/** Realpath an existing ancestor, then append the missing tail. */
function resolveLogical(p: string): string {
  const absP = abs(p);
  const existing = firstExisting(absP);
  const realExisting = tryRealpath(existing);
  const rel = relative(existing, absP);
  return rel ? resolve(realExisting, rel) : realExisting;
}

/** Refuse plugin, marketplace, and node_modules trees. Stay under user-data overrides. */
export function assertOverrideAllowed(ctx: PlatformContext, dest: string): string {
  const destAbs = abs(dest);
  const repoOverrides = abs(ctx.paths.overridesDir);
  const overridesRoot = abs(join(ctx.paths.devkitHome, "overrides"));

  if (!isInside(repoOverrides, destAbs) || !isInside(overridesRoot, destAbs)) {
    deny();
  }
  if (hasForbiddenDir(destAbs)) {
    deny();
  }

  const realDest = resolveLogical(destAbs);
  const realRoot = resolveLogical(overridesRoot);
  const realRepo = resolveLogical(repoOverrides);
  if (hasForbiddenDir(realDest) || hasForbiddenDir(realRoot) || hasForbiddenDir(realRepo)) {
    deny();
  }
  // Real dest must stay under the real DEVKIT_HOME/overrides tree, not a repo-id symlink.
  if (!isInside(realRoot, realDest) || !isInside(realRepo, realDest)) {
    deny();
  }
  return destAbs;
}

export function overrideMdPath(ctx: PlatformContext, skill: string): string {
  if (!isValidSkillName(skill)) {
    throw new PlatformError("usage", "Invalid skill name");
  }
  return join(ctx.paths.overridesDir, `${skill}.override.md`);
}

export function proposalFilePath(ctx: PlatformContext, id: string): string {
  if (!isValidProposalId(id)) {
    throw new PlatformError("usage", "Invalid proposal id");
  }
  return join(ctx.paths.proposalsDir, `${id}.json`);
}

export function historyFilePath(ctx: PlatformContext, skill: string, ts: number): string {
  if (!isValidSkillName(skill)) {
    throw new PlatformError("usage", "Invalid skill name");
  }
  return join(ctx.paths.historyDir, `${skill}.${ts}.md`);
}
