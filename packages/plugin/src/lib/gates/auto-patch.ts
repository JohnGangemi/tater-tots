import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Finding } from "@coredevkit/platform";
import { PluginError } from "../errors.js";
import { applyUserOnlyFileSync, writeFileAtomic } from "../fs-user.js";

export const STALE_HTML_HINT =
  "plan.html may be stale; re-run writing-plans if intent should change.";

export function isEligibleFinding(finding: Finding): boolean {
  return (
    finding.tag === "patch-plan" &&
    finding.evidence_type !== "none" &&
    typeof finding.patch === "string" &&
    finding.patch.length > 0
  );
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isInsideRoot(root: string, filePath: string): boolean {
  const rel = relative(root, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function assertPlanJail(opts: {
  planPath: string;
  planDir: string;
  agentPlan: string;
}): string {
  const realPlan = tryRealpath(opts.planPath);
  const realDir = tryRealpath(opts.planDir);
  const realAgent = tryRealpath(opts.agentPlan);
  if (realPlan !== realAgent || !isInsideRoot(realDir, realPlan)) {
    throw new PluginError(
      "usage",
      `plan.md must stay under the plan directory ${opts.planDir} and equal coordinator agent_plan ${opts.agentPlan}`,
    );
  }
  return realPlan;
}

function headingOrLineMatch(line: string, target: string): boolean {
  if (line === target) {
    return true;
  }
  const heading = line.match(/^(#{1,6}[ \t]+)(.*)$/);
  return Boolean(heading && heading[2] === target);
}

function splitPatch(patch: string): { first: string; leftover: string } {
  const trimmed = patch.trim();
  const parts = trimmed.split(/\r?\n/);
  const first = parts[0] ?? "";
  const leftover = parts.slice(1).join("\n");
  return { first, leftover };
}

function formatPatchEntry(
  finding: Pick<Finding, "id" | "claim">,
  patch: string,
): string {
  return [`id: ${finding.id}`, `claim: ${finding.claim}`, `patch:`, patch].join(
    "\n",
  );
}

function appendPatchSection(lines: string[], entries: string[]): string[] {
  if (entries.length === 0) {
    return lines;
  }
  const out = lines.slice();
  const extraLines = entries.join("\n\n").split("\n");
  let idx = -1;
  for (let i = 0; i < out.length; i++) {
    if (/^##[ \t]+Adversarial patches\s*$/.test(out[i] ?? "")) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    if (out.length > 0 && out[out.length - 1] !== "") {
      out.push("");
    }
    out.push("## Adversarial patches", "");
    out.push(...extraLines);
    return out;
  }
  let insertAt = idx + 1;
  if (out[insertAt] === "") {
    insertAt += 1;
  }
  while (
    insertAt < out.length &&
    !/^##[ \t]+/.test(out[insertAt] ?? "")
  ) {
    insertAt += 1;
  }
  const block = extraLines.slice();
  if (insertAt > 0 && out[insertAt - 1] !== "") {
    block.unshift("");
  }
  if (insertAt < out.length && out[insertAt] !== "") {
    block.push("");
  }
  out.splice(insertAt, 0, ...block);
  return out;
}

export type ApplyEligiblePatchesOpts = {
  planPath: string;
  planDir: string;
  agentPlan: string;
  findings: Finding[];
  sessionId: string;
  lastSessionId: string | null;
  stderr?: NodeJS.WritableStream;
};

export type ApplyEligiblePatchesResult = {
  applied: number;
  backedUp: boolean;
  wrote: boolean;
};

export async function applyEligiblePatches(
  opts: ApplyEligiblePatchesOpts,
): Promise<ApplyEligiblePatchesResult> {
  const realPlan = assertPlanJail({
    planPath: opts.planPath,
    planDir: opts.planDir,
    agentPlan: opts.agentPlan,
  });
  const eligible = opts.findings.filter(isEligibleFinding);
  if (eligible.length === 0) {
    return { applied: 0, backedUp: false, wrote: false };
  }

  let text: string;
  try {
    text = readFileSync(realPlan, "utf8");
  } catch (err) {
    throw new PluginError("io", "Could not read plan.md", String(err));
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailing = /\r?\n$/.test(text);
  let lines = text.split(/\r?\n/);
  if (hadTrailing && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  const extras: string[] = [];
  for (const finding of eligible) {
    const target = finding.plan_target;
    const patch = finding.patch ?? "";
    const { first, leftover } = splitPatch(patch);
    let matched = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || !headingOrLineMatch(line, target)) {
        continue;
      }
      lines[i] = first;
      matched = true;
      if (leftover.length > 0) {
        extras.push(formatPatchEntry(finding, leftover));
      }
      break;
    }
    if (!matched) {
      extras.push(formatPatchEntry(finding, patch));
    }
  }
  lines = appendPatchSection(lines, extras);

  const next = `${lines.join(newline)}${hadTrailing ? newline : ""}`;
  if (next === text) {
    return { applied: 0, backedUp: false, wrote: false };
  }

  const bakPath = join(dirname(realPlan), "plan.md.bak");
  let backedUp = false;
  const alreadyThisSession =
    opts.lastSessionId === opts.sessionId && existsSync(bakPath);
  if (!alreadyThisSession) {
    try {
      await writeFileAtomic(bakPath, text);
      applyUserOnlyFileSync(bakPath);
      backedUp = true;
    } catch (err) {
      throw new PluginError("io", "Could not write plan.md.bak", String(err));
    }
  }

  try {
    await writeFileAtomic(realPlan, next);
    applyUserOnlyFileSync(realPlan);
  } catch (err) {
    throw new PluginError("io", "Could not write plan.md", String(err));
  }
  opts.stderr?.write(`${STALE_HTML_HINT}\n`);
  return { applied: eligible.length, backedUp, wrote: true };
}
