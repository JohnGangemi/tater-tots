import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "@coredevkit/platform";
import {
  currentStackItem,
  type StackSkipOpts,
} from "../coordinator/resume.js";
import {
  TERMINAL,
  type CoordinatorRecord,
} from "../coordinator/types.js";
import { PluginError } from "../errors.js";
import { writeProgressAtomic } from "../fs-user.js";
import { evidenceGateExit } from "../gates/evidence.js";
import { logPlugin } from "../log.js";
import type { PlatformModule } from "../platform-guard.js";
import {
  GH_MISSING_MSG,
  publishStack,
  unionAllowedPaths,
} from "../stack/create.js";
import {
  ghAvailable,
  ghCreatePr,
  ghDefaultBranch,
} from "../stack/gh.js";
import {
  gitAddPaths,
  gitCommit,
  gitIdentity,
  gitOk,
  gitOriginHead,
  gitPushBranch,
  hasOrigin,
  runGit,
  type GitOpts,
} from "../stack/git.js";
import { formatSow, type IssueSnap } from "./gh-issue.js";

export type IssueMeta = {
  number: number;
  url: string;
  title: string;
};

export function sowFilePath(
  progressDir: string,
  worktreeHash: string,
): string {
  return join(progressDir, `${worktreeHash}.sow.md`);
}

export async function writeSow(
  progressDir: string,
  worktreeHash: string,
  issue: IssueSnap,
): Promise<string> {
  const dest = sowFilePath(progressDir, worktreeHash);
  const tmpDir = join(progressDir, ".tmp");
  await writeProgressAtomic(dest, formatSow(issue), tmpDir);
  return dest;
}

export function issueMetaFrom(issue: IssueSnap): IssueMeta {
  return {
    number: issue.number,
    url: issue.url,
    title: issue.title,
  };
}

export function draftPhase(
  agentPlan: string,
): "draft_plan" | "refine" {
  return existsSync(agentPlan) ? "refine" : "draft_plan";
}

function allStepsTerminal(record: CoordinatorRecord): boolean {
  return record.steps.every((s) => TERMINAL.has(s.status));
}

function stackSkip(git: GitOpts): StackSkipOpts {
  return { hasGh: ghAvailable(git), hasRemote: hasOrigin(git) };
}

function touch(record: CoordinatorRecord): void {
  record.updated_at = new Date().toISOString();
}

function resolveDefaultBranch(
  record: CoordinatorRecord,
  git: GitOpts,
  hasGh: boolean,
): string {
  if (hasGh) {
    const fromGh = ghDefaultBranch(git);
    if (fromGh) {
      record.stack.default_branch = fromGh;
      return fromGh;
    }
  }
  const fromOrigin = gitOriginHead(git);
  if (fromOrigin) {
    record.stack.default_branch = fromOrigin;
    return fromOrigin;
  }
  if (!record.stack.default_branch) {
    record.stack.default_branch = "main";
  }
  return record.stack.default_branch;
}

function unionAllPaths(record: CoordinatorRecord): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of record.steps) {
    for (const p of step.allowed_paths) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  if (out.length === 0) {
    for (const pr of record.stack.prs) {
      for (const p of unionAllowedPaths(record, pr)) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
  }
  return out;
}

function prTitle(record: CoordinatorRecord): string {
  return (
    record.issue?.title?.split("\n")[0]?.trim() ||
    record.plan_id ||
    "issue-to-pr"
  );
}

function issueBranch(record: CoordinatorRecord): string {
  const n = record.issue?.number;
  return n ? `issue-${n}` : `issue-${record.plan_id}`;
}

async function runWholePlanTests(
  platform: PlatformModule,
  ctx: PlatformContext,
  record: CoordinatorRecord,
): Promise<void> {
  const level = ctx.config.resolved_level;
  if (level !== "light" && level !== "full") {
    record.pipeline_phase = "tests";
    touch(record);
    return;
  }
  record.pipeline_phase = "tests";
  touch(record);
  for (const purpose of ["test", "build", "lint"] as const) {
    const result = await platform.evidenceCheck(ctx, { purpose });
    const gate = evidenceGateExit(result);
    if (gate === 0) {
      continue;
    }
    logPlugin(ctx.env, {
      event: "plugin.gate.blocked",
      repo_id: ctx.repoId,
      code: "evidence",
      result: result.verdict,
    });
    throw new PluginError(
      gate === 3 ? "io" : "blocked",
      `evidence ${result.verdict}`,
    );
  }
}

async function publishSinglePr(opts: {
  ctx: PlatformContext;
  platform: PlatformModule;
  record: CoordinatorRecord;
  write: (record: CoordinatorRecord) => Promise<void>;
  io: { stderr: NodeJS.WritableStream };
}): Promise<{ record: CoordinatorRecord; hint: string }> {
  const { ctx, platform, record, write, io } = opts;
  if (!allStepsTerminal(record)) {
    throw new PluginError("usage", "finish steps first");
  }
  const git: GitOpts = { cwd: ctx.repoPath, env: ctx.env };
  const hasGh = ghAvailable(git);
  const remote = hasOrigin(git);
  const base = resolveDefaultBranch(record, git, hasGh);
  await runWholePlanTests(platform, ctx, record);
  await write(record);

  record.pipeline_phase = "publish";
  touch(record);
  await write(record);

  const paths = unionAllPaths(record);
  if (paths.length === 0) {
    throw new PluginError("usage", "issue-to-pr has no allowed_paths");
  }
  const branch = issueBranch(record);
  gitOk(["checkout", "-B", branch], git);
  const identity = gitIdentity(git);
  gitAddPaths(paths, git);
  const cached = runGit(["diff", "--cached", "--quiet"], git);
  if (cached.status !== 0) {
    gitCommit(prTitle(record), identity, git);
  }
  if (remote) {
    gitPushBranch(branch, git);
  }
  if (!hasGh) {
    io.stderr.write(`devkit: ${GH_MISSING_MSG}\n`);
    await write(record);
    return { record, hint: GH_MISSING_MSG };
  }
  if (!remote) {
    await write(record);
    return { record, hint: "run git push then gh pr create" };
  }
  const created = ghCreatePr(
    {
      base,
      head: branch,
      title: prTitle(record),
      body: record.issue
        ? `Closes #${record.issue.number}.`
        : "Issue to pull request.",
    },
    git,
  );
  if (created.missing) {
    io.stderr.write(`devkit: ${GH_MISSING_MSG}\n`);
    await write(record);
    return { record, hint: GH_MISSING_MSG };
  }
  record.pipeline_phase = "complete";
  touch(record);
  await write(record);
  logPlugin(ctx.env, {
    event: "plugin.stack.create",
    repo_id: ctx.repoId,
    result: "created",
  });
  return {
    record,
    hint: created.pr.url ?? "pull request created",
  };
}

function afterStackPublish(
  record: CoordinatorRecord,
  skip: StackSkipOpts,
): CoordinatorRecord["pipeline_phase"] {
  const item = currentStackItem(record, skip);
  if (!item) {
    return "complete";
  }
  if (item.phase === "checked_out") {
    return "implement";
  }
  return "publish";
}

export async function publishIssue(opts: {
  ctx: PlatformContext;
  platform: PlatformModule;
  record: CoordinatorRecord;
  write: (record: CoordinatorRecord) => Promise<void>;
  io: { stderr: NodeJS.WritableStream };
}): Promise<{
  record: CoordinatorRecord;
  hint: string;
  item: CoordinatorRecord["stack"]["prs"][number] | null;
}> {
  const { ctx, record, write, io } = opts;
  if (record.stack.enabled) {
    const git: GitOpts = { cwd: ctx.repoPath, env: ctx.env };
    const skip = stackSkip(git);
    const out = await publishStack({ ctx, record, write, io });
    out.record.pipeline_phase = afterStackPublish(out.record, skip);
    touch(out.record);
    await write(out.record);
    return out;
  }
  const single = await publishSinglePr(opts);
  return { record: single.record, hint: single.hint, item: null };
}

export function stackSkipFromCtx(ctx: PlatformContext): StackSkipOpts {
  return stackSkip({ cwd: ctx.repoPath, env: ctx.env });
}

export { allStepsTerminal };
