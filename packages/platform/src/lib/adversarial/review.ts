import { readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";
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

function isInsideRepo(repoPath: string, filePath: string): boolean {
  const rel = relative(repoPath, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function resolvePlanPath(repoPath: string, planPath: string): string {
  if (!planPath || planPath.length > PLAN_PATH_MAX) {
    throw new PlatformError("usage", "plan_path length is invalid");
  }
  const abs = isAbsolute(planPath) ? planPath : resolve(repoPath, planPath);
  if (!abs.endsWith(".md") && !planPath.endsWith(".md")) {
    throw new PlatformError("usage", "plan_path must end with .md");
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new PlatformError("not_found", `Plan file not found: ${planPath}`);
  }
  let realRepo = repoPath;
  try {
    realRepo = realpathSync(repoPath);
  } catch {
    // keep repoPath
  }
  if (!isInsideRepo(realRepo, real)) {
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

  const real = resolvePlanPath(ctx.repoPath, planPath);
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
  return {
    verdict: contract.verdict,
    findings: contract.findings,
    dropped_illegal: contract.dropped_illegal,
    plan_path: real,
    graph_ready: gate.ready,
    resolved_level,
  };
}
