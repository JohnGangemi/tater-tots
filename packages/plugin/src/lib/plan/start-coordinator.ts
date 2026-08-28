import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { playbookList, type PlatformContext } from "@coredevkit/platform";
import { PluginError } from "../errors.js";
import type { PluginConfig } from "../plugin-config.js";
import { worktreeHash } from "../worktree.js";
import {
  withProgressLock,
  type CoordinatorOpts,
} from "../coordinator/store.js";
import { resumeStep } from "../coordinator/resume.js";
import type {
  CoordinatorRecord,
  CoordinatorStep,
} from "../coordinator/types.js";
import { requirePlanMdSteps } from "../coordinator/parse-plan-md.js";
import {
  applyStackIds,
  assertStackPrs,
  seedStackPrs,
} from "../coordinator/seed-stack.js";
import { loadIntentFile, type PlanIntent, type StackItem } from "./intent.js";
import { planFilePaths } from "./paths.js";

export type StartCoordinatorInput = CoordinatorOpts & {
  planDir: string;
  replace: boolean;
  slug?: string;
  plugin: PluginConfig;
};

function slugify(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "plan";
}

function newPlanId(title: string, slug?: string): string {
  const base = slug?.trim() ? slugify(slug) : slugify(title);
  return `${base}-${randomBytes(3).toString("hex")}`;
}

function mergeSteps(
  existing: CoordinatorStep[],
  parsed: CoordinatorStep[],
): CoordinatorStep[] {
  const oldById = new Map(existing.map((s) => [s.id, s]));
  const out: CoordinatorStep[] = [];
  const seen = new Set<string>();
  for (const next of parsed) {
    seen.add(next.id);
    const prev = oldById.get(next.id);
    if (prev) {
      out.push({
        ...next,
        status: prev.status,
        evidence: prev.evidence,
        summaries: prev.summaries,
        blocked_reason: prev.blocked_reason,
        command_key: next.command_key ?? prev.command_key,
      });
    } else {
      out.push({ ...next, status: "pending" });
    }
  }
  for (const prev of existing) {
    if (seen.has(prev.id)) {
      continue;
    }
    if (prev.status === "pending" || prev.status === "skipped") {
      continue;
    }
    out.push(prev);
  }
  return out;
}

function blockingIds(intent: PlanIntent | null): string[] {
  if (!intent) {
    return [];
  }
  return intent.open_questions
    .filter((q) => q.blocks && q.status === "open")
    .map((q) => q.id);
}

function stackItemsFor(
  intent: PlanIntent | null,
  fromMd: StackItem[],
): StackItem[] {
  if (intent && intent.stack.length > 0) {
    return intent.stack;
  }
  return fromMd;
}

function freshRecord(
  ctx: PlatformContext,
  paths: ReturnType<typeof planFilePaths>,
  steps: CoordinatorStep[],
  prs: CoordinatorRecord["stack"]["prs"],
  intent: PlanIntent | null,
  slug: string | undefined,
): CoordinatorRecord {
  const wt = worktreeHash(ctx.repoPath);
  const now = new Date().toISOString();
  const enabled = prs.length > 0;
  const record: CoordinatorRecord = {
    version: 1,
    repo_id: ctx.repoId,
    worktree_hash: wt.worktree_hash,
    worktree_sha256: wt.worktree_sha256,
    plan_id: newPlanId(intent?.title ?? "plan", slug),
    plan_dir: paths.planDir,
    intent_path: paths.intentPath,
    agent_plan: paths.agentPlan,
    html_path: paths.htmlPath,
    source: "plan",
    issue: null,
    pipeline_phase: null,
    created_at: now,
    updated_at: now,
    verification_level: ctx.config.resolved_level,
    adversarial: {
      status: "skipped",
      verdict: null,
      ran_at: null,
      session_id: null,
      findings_hash: null,
    },
    resume_step_id: steps[0]?.id ?? null,
    blocking_open_question_ids: blockingIds(intent),
    stack: {
      enabled,
      default_branch: "main",
      prs,
    },
    events: [],
    steps,
  };
  record.resume_step_id = resumeStep(record);
  return record;
}

export async function startCoordinator(
  ctx: PlatformContext,
  input: StartCoordinatorInput,
): Promise<CoordinatorRecord> {
  const paths = planFilePaths(input.planDir);
  if (!existsSync(paths.agentPlan)) {
    throw new PluginError("not_found", `plan.md not found: ${paths.agentPlan}`);
  }
  let md: string;
  try {
    md = readFileSync(paths.agentPlan, "utf8");
  } catch (err) {
    throw new PluginError("io", "Could not read plan.md", String(err));
  }

  const entries = await ctxPlaybook(ctx);
  const parsed = requirePlanMdSteps(md, entries);
  const intent = existsSync(paths.intentPath)
    ? loadIntentFile(paths.intentPath, {
        htmlCodeBlocks: input.plugin.plugin.html_code_blocks,
      })
    : null;
  const items = stackItemsFor(intent, parsed.stackItems);
  const steps = applyStackIds(parsed.steps, items);

  return withProgressLock(ctx, input, async (api) => {
    const got = api.tryRead();
    if (got.corrupt && !input.replace) {
      throw new PluginError("usage", "coordinator file is corrupt");
    }
    if (got.corrupt && input.replace) {
      const prs = seedStackPrs(items, steps, []);
      const rec = freshRecord(ctx, paths, steps, prs, intent, input.slug);
      await api.write(rec);
      return rec;
    }
    const existing = got.record;
    if (!existing || input.replace) {
      const prs = seedStackPrs(items, steps, []);
      const rec = freshRecord(ctx, paths, steps, prs, intent, input.slug);
      await api.write(rec);
      return rec;
    }

    const mergedSteps = mergeSteps(existing.steps, steps);
    applyStackIds(mergedSteps, items);
    const prs = seedStackPrs(items, mergedSteps, existing.stack.prs);
    const enabled = existing.stack.enabled || prs.length > 0;
    assertStackPrs(enabled, prs);
    const keepResume =
      existing.resume_step_id &&
      mergedSteps.some((s) => s.id === existing.resume_step_id)
        ? existing.resume_step_id
        : null;
    const rec: CoordinatorRecord = {
      ...existing,
      plan_dir: paths.planDir,
      intent_path: paths.intentPath,
      agent_plan: paths.agentPlan,
      html_path: paths.htmlPath,
      updated_at: new Date().toISOString(),
      verification_level: ctx.config.resolved_level,
      blocking_open_question_ids: blockingIds(intent),
      stack: {
        enabled,
        default_branch: existing.stack.default_branch,
        prs,
      },
      steps: mergedSteps,
      resume_step_id: keepResume,
    };
    rec.resume_step_id =
      keepResume ?? resumeStep({ ...rec, resume_step_id: null });
    await api.write(rec);
    return rec;
  });
}

async function ctxPlaybook(ctx: PlatformContext) {
  return playbookList(ctx, ctx.config.playbook.max_entries);
}
