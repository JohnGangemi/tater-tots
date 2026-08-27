import { readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";
import { patternHash, recordSignal } from "../tune/store.js";
import {
  checkCommands,
  checkPaths,
  checkSections,
  checkSymbols,
  type GraphGate,
} from "./checkers.js";
import { applyFindingContract } from "./contract.js";
import { extractCommands, extractPlanPaths, extractSectionSymbols } from "./parse.js";
import type { AdversarialInput, AdversarialResult } from "./types.js";

const PLAN_PATH_MAX = 400;

function emptyResult(
  plan_path: string,
  resolved_level: AdversarialResult["resolved_level"],
): AdversarialResult {
  return {
    verdict: "PASS",
    findings: [],
    dropped_illegal: 0,
    plan_path,
    graph_ready: false,
    resolved_level,
  };
}

function isInsideRoot(root: string, filePath: string): boolean {
  const rel = relative(root, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isAllowedPlanPath(ctx: PlatformContext, filePath: string): boolean {
  const repoPath = ctx.repoPath;
  const realRepo = tryRealpath(repoPath);
  const plansRoot = join(ctx.paths.devkitHome, "plans");
  const realPlans = tryRealpath(plansRoot);
  return (
    isInsideRoot(repoPath, filePath) ||
    isInsideRoot(realRepo, filePath) ||
    isInsideRoot(plansRoot, filePath) ||
    isInsideRoot(realPlans, filePath)
  );
}

function resolvePlanPath(ctx: PlatformContext, planPath: string): string {
  if (!planPath || planPath.length > PLAN_PATH_MAX) {
    throw new PlatformError("usage", "plan_path length is invalid");
  }
  const abs = isAbsolute(planPath) ? planPath : resolve(ctx.repoPath, planPath);
  if (!abs.endsWith(".md") && !planPath.endsWith(".md")) {
    throw new PlatformError("usage", "plan_path must end with .md");
  }
  // Jail on the resolved path first so outside files are not probed.
  if (!isAllowedPlanPath(ctx, abs)) {
    throw new PlatformError("usage", "plan_path must be inside the repo");
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new PlatformError("not_found", `Plan file not found: ${planPath}`);
  }
  if (!isAllowedPlanPath(ctx, real)) {
    throw new PlatformError("usage", "plan_path must be inside the repo");
  }
  if (!real.endsWith(".md")) {
    throw new PlatformError("usage", "plan_path must end with .md");
  }
  try {
    if (!statSync(real).isFile()) {
      throw new PlatformError("usage", "plan_path must be a file");
    }
  } catch (err) {
    if (err instanceof PlatformError) {
      throw err;
    }
    throw new PlatformError("not_found", `Plan file not found: ${planPath}`);
  }
  return real;
}

export async function adversarialReview(
  ctx: PlatformContext,
  q: AdversarialInput,
): Promise<AdversarialResult> {
  const resolved_level = ctx.config.resolved_level;
  const planPath = q.plan_path.trim();
  if (resolved_level === "off") {
    return emptyResult(planPath, "off");
  }

  const real = resolvePlanPath(ctx, planPath);
  let text: string;
  try {
    text = await readFile(real, "utf8");
  } catch {
    throw new PlatformError("io", "Could not read plan file");
  }

  const gate: GraphGate = { ready: false, known: false };
  const findings = [
    ...checkSections(text),
    ...(await checkPaths(ctx, extractPlanPaths(text), gate)),
    ...(await checkCommands(ctx, extractCommands(text))),
    ...(await checkSymbols(ctx, extractSectionSymbols(text), gate)),
  ];
  const contract = applyFindingContract(findings);
  await emitPatchSignals(ctx, contract.findings);
  return {
    verdict: contract.verdict,
    findings: contract.findings,
    dropped_illegal: contract.dropped_illegal,
    plan_path: real,
    graph_ready: gate.ready,
    resolved_level,
  };
}

async function emitPatchSignals(
  ctx: PlatformContext,
  findings: AdversarialResult["findings"],
): Promise<void> {
  const seen = new Set<string>();
  for (const finding of findings) {
    if (finding.tag !== "patch-plan") {
      continue;
    }
    const pattern_hash = patternHash(finding.category, finding.tag);
    if (seen.has(pattern_hash)) {
      continue;
    }
    seen.add(pattern_hash);
    try {
      await recordSignal(ctx, {
        kind: "adversarial_patch_pattern",
        fact: {
          category: finding.category,
          tag: finding.tag,
          pattern_hash,
        },
      });
    } catch {
      // tuning must not fail review
    }
  }
}
