import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;

const FORBIDDEN_DIR = new Set(["plugins", "marketplace", "node_modules"]);

export function isValidSkillName(skill: string): boolean {
  return skill.length > 0 && skill.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(skill);
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
    if (FORBIDDEN_DIR.has(seg)) {
      return true;
    }
    if (seg === ".claude" && dirs[i + 1] === "plugins") {
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

  const realExisting = tryRealpath(firstExisting(destAbs));
  if (hasForbiddenDir(realExisting)) {
    deny();
  }
  if (existsSync(destAbs) && hasForbiddenDir(tryRealpath(destAbs))) {
    deny();
  }
  if (existsSync(repoOverrides) && hasForbiddenDir(tryRealpath(repoOverrides))) {
    deny();
  }
  if (existsSync(overridesRoot) && hasForbiddenDir(tryRealpath(overridesRoot))) {
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
  return join(ctx.paths.proposalsDir, `${id}.json`);
}

export function historyFilePath(ctx: PlatformContext, skill: string, ts: number): string {
  if (!isValidSkillName(skill)) {
    throw new PlatformError("usage", "Invalid skill name");
  }
  return join(ctx.paths.historyDir, `${skill}.${ts}.md`);
}
