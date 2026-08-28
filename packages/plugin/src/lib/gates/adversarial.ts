import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  AdversarialInput,
  AdversarialResult,
  Finding,
  PlatformContext,
} from "@coredevkit/platform";
import { parsePlanMd } from "../coordinator/parse-plan-md.js";
import type {
  AdversarialFindingSnap,
  AdversarialStatus,
  CoordinatorRecord,
  CoordinatorStep,
} from "../coordinator/types.js";
import { PluginError } from "../errors.js";
import { logPlugin } from "../log.js";
import { applyEligiblePatches } from "./auto-patch.js";

export type AdversarialVerdict = "BLOCK" | "PATCH" | "PASS";

export function newAdversarialSessionId(): string {
  return randomBytes(8).toString("hex");
}

export function shouldRunAdversarial(opts: {
  resolved_level: "off" | "light" | "full";
  status: AdversarialStatus;
  verdict: AdversarialVerdict | null;
  stepCount: number;
  stackEnabled: boolean;
  source: "plan" | "issue-to-pr";
  minSteps: number;
}): boolean {
  if (opts.resolved_level !== "full") {
    return false;
  }
  if (opts.status === "passed") {
    return false;
  }
  if (opts.verdict === "PATCH") {
    return false;
  }
  if (opts.status === "blocked") {
    return true;
  }
  const trigger =
    opts.stepCount >= opts.minSteps ||
    opts.stackEnabled ||
    opts.source === "issue-to-pr";
  return trigger;
}

export function acceptAdversarialPatch(record: CoordinatorRecord): void {
  if (
    record.adversarial.verdict !== "PATCH" ||
    record.adversarial.status === "passed"
  ) {
    throw new PluginError("usage", "adversarial verdict is not PATCH");
  }
  record.adversarial.status = "passed";
  record.updated_at = new Date().toISOString();
}

export function findingsHash(findings: Finding[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        findings.map((f) => ({
          id: f.id,
          tag: f.tag,
          plan_target: f.plan_target,
          patch: f.patch,
        })),
      ),
    )
    .digest("hex")
    .slice(0, 16);
}

export function snapFindings(findings: Finding[]): AdversarialFindingSnap[] {
  return findings.map((f) => ({
    id: f.id,
    tag: f.tag,
    claim: f.claim,
  }));
}

export function printAdversarialFindings(
  stderr: NodeJS.WritableStream,
  findings: AdversarialFindingSnap[],
): void {
  for (const f of findings) {
    stderr.write(`${f.id} ${f.tag}: ${f.claim}\n`);
  }
}

function mergePatchedSteps(
  existing: CoordinatorStep[],
  parsed: CoordinatorStep[],
): CoordinatorStep[] {
  const oldById = new Map(existing.map((s) => [s.id, s]));
  return parsed.map((next) => {
    const prev = oldById.get(next.id);
    if (!prev) {
      return next;
    }
    return {
      ...next,
      status: prev.status,
      evidence: prev.evidence,
      summaries: prev.summaries,
      blocked_reason: prev.blocked_reason,
      command_key: next.command_key ?? prev.command_key,
    };
  });
}

function storeRun(
  record: CoordinatorRecord,
  opts: {
    status: AdversarialStatus;
    verdict: AdversarialVerdict;
    sessionId: string;
    findings: Finding[];
  },
): void {
  const at = new Date().toISOString();
  record.adversarial.status = opts.status;
  record.adversarial.verdict = opts.verdict;
  record.adversarial.ran_at = at;
  record.adversarial.session_id = opts.sessionId;
  record.adversarial.findings_hash = findingsHash(opts.findings);
  record.adversarial.findings = snapFindings(opts.findings);
  record.updated_at = at;
}

export type AdversarialReviewFn = (
  ctx: PlatformContext,
  q: AdversarialInput,
) => Promise<AdversarialResult>;

export type AdversarialCheckpointAction = "continue" | "block" | "wait_accept";

export type RunAdversarialCheckpointOpts = {
  ctx: PlatformContext;
  record: CoordinatorRecord;
  autoPatch: boolean;
  sessionId: string;
  review: AdversarialReviewFn;
  stderr: NodeJS.WritableStream;
};

export async function runAdversarialCheckpoint(
  opts: RunAdversarialCheckpointOpts,
): Promise<{ action: AdversarialCheckpointAction; result: AdversarialResult | null }> {
  const { ctx, record, sessionId } = opts;
  if (record.adversarial.status === "passed") {
    return { action: "continue", result: null };
  }
  if (
    record.adversarial.session_id === sessionId &&
    record.adversarial.ran_at
  ) {
    if (record.adversarial.status === "blocked") {
      return { action: "block", result: null };
    }
    if (record.adversarial.verdict === "PATCH") {
      return { action: "wait_accept", result: null };
    }
    return { action: "continue", result: null };
  }

  const result = await opts.review(ctx, { plan_path: record.agent_plan });
  if (result.verdict === "BLOCK") {
    storeRun(record, {
      status: "blocked",
      verdict: "BLOCK",
      sessionId,
      findings: result.findings,
    });
    printAdversarialFindings(opts.stderr, record.adversarial.findings);
    logPlugin(ctx.env, {
      event: "plugin.adversarial.blocked",
      repo_id: ctx.repoId,
      result: "BLOCK",
    });
    return { action: "block", result };
  }
  if (result.verdict === "PASS") {
    storeRun(record, {
      status: "passed",
      verdict: "PASS",
      sessionId,
      findings: result.findings,
    });
    logPlugin(ctx.env, {
      event: "plugin.adversarial.passed",
      repo_id: ctx.repoId,
      result: "PASS",
    });
    return { action: "continue", result };
  }

  printAdversarialFindings(opts.stderr, snapFindings(result.findings));
  if (opts.autoPatch) {
    const lastSessionId = record.adversarial.session_id;
    const applied = await applyEligiblePatches({
      planPath: record.agent_plan,
      planDir: record.plan_dir,
      agentPlan: record.agent_plan,
      findings: result.findings,
      sessionId,
      lastSessionId,
      stderr: opts.stderr,
    });
    if (applied.wrote) {
      let md: string;
      try {
        md = readFileSync(record.agent_plan, "utf8");
      } catch (err) {
        throw new PluginError("io", "Could not read plan.md", String(err));
      }
      const parsed = parsePlanMd(md).steps;
      if (parsed.length > 0) {
        record.steps = mergePatchedSteps(record.steps, parsed);
      }
    }
    storeRun(record, {
      status: "passed",
      verdict: "PATCH",
      sessionId,
      findings: result.findings,
    });
    logPlugin(ctx.env, {
      event: "plugin.adversarial.passed",
      repo_id: ctx.repoId,
      result: "PATCH",
    });
    return { action: "continue", result };
  }

  const prior = record.adversarial.status;
  storeRun(record, {
    status: prior === "blocked" ? "skipped" : prior,
    verdict: "PATCH",
    sessionId,
    findings: result.findings,
  });
  logPlugin(ctx.env, {
    event: "plugin.gate.blocked",
    repo_id: ctx.repoId,
    code: "accept-patch",
    result: "PATCH",
  });
  return { action: "wait_accept", result };
}

export function markAdversarialSkipped(record: CoordinatorRecord): boolean {
  if (record.adversarial.status === "passed") {
    return false;
  }
  if (record.adversarial.verdict === "PATCH") {
    return false;
  }
  if (
    record.adversarial.status === "blocked" ||
    record.adversarial.verdict === "BLOCK"
  ) {
    return false;
  }
  if (record.adversarial.status === "skipped") {
    return false;
  }
  record.adversarial.status = "skipped";
  record.updated_at = new Date().toISOString();
  return true;
}
