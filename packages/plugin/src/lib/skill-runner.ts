import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "@coredevkit/platform";
import { PluginError } from "./errors.js";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;
const OVERRIDE_MD_MAX_LINES = 40;
const OVERRIDE_HEADING = /^#+ *Personal override\s*$/i;

function isValidSkillName(skill: string): boolean {
  return (
    skill.length > 0 &&
    skill.length <= SKILL_NAME_MAX &&
    SKILL_NAME_RE.test(skill)
  );
}

function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  const body = m ? text.slice(m[0].length) : text;
  return body.replace(/^\r?\n/, "").replace(/\s+$/, "");
}

export function loadSkillBody(
  ctx: PlatformContext,
  skill: string,
  shippedDir: string,
): string {
  if (!isValidSkillName(skill)) {
    throw new PluginError("usage", "Invalid skill name");
  }
  const shippedPath = join(shippedDir, skill, "SKILL.md");
  if (!existsSync(shippedPath)) {
    throw new PluginError("not_found", `Skill not found: ${skill}`);
  }
  let shippedRaw: string;
  try {
    shippedRaw = readFileSync(shippedPath, "utf8");
  } catch (err) {
    throw new PluginError("io", `Could not read skill ${skill}`, String(err));
  }
  const shippedBody = stripFrontmatter(shippedRaw);
  const overridePath = join(ctx.paths.overridesDir, `${skill}.override.md`);
  if (!existsSync(overridePath)) {
    return `${shippedBody}\n`;
  }
  let overrideRaw: string;
  try {
    overrideRaw = readFileSync(overridePath, "utf8");
  } catch (err) {
    throw new PluginError(
      "io",
      `Could not read override for ${skill}`,
      String(err),
    );
  }
  const lines = overrideRaw.split(/\r?\n/).slice(0, OVERRIDE_MD_MAX_LINES);
  if (lines[0] !== undefined && OVERRIDE_HEADING.test(lines[0].trim())) {
    lines.shift();
    if (lines[0] === "") {
      lines.shift();
    }
  }
  const capped = lines.join("\n").replace(/\s+$/, "");
  return `${shippedBody}\n\n## Personal override\n\n${capped}\n`;
}
