import { existsSync, readFileSync } from "node:fs";
import type { PlatformContext } from "@coredevkit/platform";
import {
  applyStackIds,
  assertStackPrs,
  seedStackPrs,
  topoStackItems,
} from "../coordinator/seed-stack.js";
import { currentStackItem } from "../coordinator/resume.js";
import { parsePlanMd } from "../coordinator/parse-plan-md.js";
import {
  TERMINAL,
  type CoordinatorRecord,
  type StackPr,
} from "../coordinator/types.js";
import { PluginError } from "../errors.js";
import { logPlugin } from "../log.js";
import { loadIntentFile, type StackItem } from "../plan/intent.js";
import { ghAvailable, ghCreatePr, ghDefaultBranch } from "./gh.js";
import {
  gitAddPaths,
  gitCheckoutBranch,
  gitCommit,
  gitCurrentBranch,
  gitFetchOrigin,
  gitIdentity,
  gitOriginHead,
  gitPushBranch,
  hasOrigin,
  isDirty,
  type GitOpts,
} from "./git.js";

export const GH_MISSING_MSG = "PR not opened because gh is missing.";

export type StackPublishIo = {
  stderr: NodeJS.WritableStream;
};

export type StackPublishResult = {
  record: CoordinatorRecord;
  hint: string;
  item: StackPr | null;
};

function loadStackItems(record: CoordinatorRecord): StackItem[] {
  if (existsSync(record.intent_path)) {
    const intent = loadIntentFile(record.intent_path);
    if (intent.stack.length > 0) {
      return intent.stack;
    }
  }
  if (existsSync(record.agent_plan)) {
    const md = readFileSync(record.agent_plan, "utf8");
    return parsePlanMd(md).stackItems;
  }
  return [];
}

function seedIfEmpty(record: CoordinatorRecord): void {
  if (!record.stack.enabled) {
    throw new PluginError("usage", "stack is not enabled");
  }
  if (record.stack.prs.length > 0) {
    return;
  }
  const items = loadStackItems(record);
  const prs = seedStackPrs(items, record.steps, []);
  applyStackIds(record.steps, items);
  record.stack.prs = prs;
  record.stack.enabled = record.stack.enabled || prs.length > 0;
  assertStackPrs(record.stack.enabled, record.stack.prs);
}

export function resolveStackBase(
  record: CoordinatorRecord,
  item: StackPr,
  items: StackItem[],
): string {
  const fallback = record.stack.default_branch ?? "main";
  const spec = items.find((i) => i.id === item.stack_id);
  if (spec && spec.depends_on.length > 0) {
    const ordered = topoStackItems(items);
    const want = new Set(spec.depends_on);
    let last: string | undefined;
    for (const it of ordered) {
      if (want.has(it.id)) {
        last = it.id;
      }
    }
    last = last ?? spec.depends_on[spec.depends_on.length - 1];
    const dep = record.stack.prs.find((p) => p.stack_id === last);
    if (!dep) {
      throw new PluginError(
        "usage",
        `stack ${item.stack_id} depends_on unknown id ${String(last)}`,
      );
    }
    return dep.branch;
  }
  const base = spec?.base ?? item.base;
  if (!base || base === "@default") {
    return fallback;
  }
  const asId = record.stack.prs.find((p) => p.stack_id === base);
  if (asId) {
    return asId.branch;
  }
  return base;
}

export function unionAllowedPaths(
  record: CoordinatorRecord,
  item: StackPr,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of record.steps) {
    if (step.stack_id !== item.stack_id) {
      continue;
    }
    for (const p of step.allowed_paths) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  if (out.length === 0) {
    for (const p of item.allowed_paths) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

function itemStepsTerminal(
  record: CoordinatorRecord,
  item: StackPr,
): boolean {
  return record.steps
    .filter((s) => s.stack_id === item.stack_id)
    .every((s) => TERMINAL.has(s.status));
}

function firstItemStep(
  record: CoordinatorRecord,
  item: StackPr,
): string | null {
  return (
    record.steps.find(
      (s) => s.stack_id === item.stack_id && !TERMINAL.has(s.status),
    )?.id ?? null
  );
}

function itemTitle(
  record: CoordinatorRecord,
  item: StackPr,
  items: StackItem[],
): string {
  const spec = items.find((i) => i.id === item.stack_id);
  const stepTitle = record.steps.find(
    (s) => s.stack_id === item.stack_id,
  )?.step_title;
  const raw = spec?.title || stepTitle || item.stack_id;
  return raw.split("\n")[0]?.trim() || item.stack_id;
}

function localCompleteWithoutGh(
  item: StackPr,
  hasGh: boolean,
  remote: boolean,
): boolean {
  if (hasGh) {
    return false;
  }
  if (item.phase === "pushed") {
    return true;
  }
  return item.phase === "committed" && !remote;
}

function nextWorkItem(
  record: CoordinatorRecord,
  hasGh: boolean,
  remote: boolean,
): StackPr | undefined {
  return record.stack.prs.find((p) => {
    if (p.phase === "pr_created") {
      return false;
    }
    if (localCompleteWithoutGh(p, hasGh, remote)) {
      return false;
    }
    return true;
  });
}

function moreHint(
  record: CoordinatorRecord,
  hasGh: boolean,
  remote: boolean,
): string {
  return nextWorkItem(record, hasGh, remote)
    ? "run devkit stack publish"
    : "stack complete";
}

function noteGhMissing(io: StackPublishIo): void {
  io.stderr.write(`devkit: ${GH_MISSING_MSG}\n`);
}

function lastPr(record: CoordinatorRecord): StackPr | null {
  return record.stack.prs[record.stack.prs.length - 1] ?? null;
}

function resolveDefaultBranch(
  record: CoordinatorRecord,
  git: GitOpts,
  hasGh: boolean,
): void {
  if (hasGh) {
    const fromGh = ghDefaultBranch(git);
    if (fromGh) {
      record.stack.default_branch = fromGh;
      return;
    }
  }
  const fromOrigin = gitOriginHead(git);
  if (fromOrigin) {
    record.stack.default_branch = fromOrigin;
    return;
  }
  if (!record.stack.default_branch) {
    record.stack.default_branch = "main";
  }
}

function touch(record: CoordinatorRecord): void {
  record.updated_at = new Date().toISOString();
}

export async function publishStack(opts: {
  ctx: PlatformContext;
  record: CoordinatorRecord;
  write: (record: CoordinatorRecord) => Promise<void>;
  io: StackPublishIo;
}): Promise<StackPublishResult> {
  const { ctx, record, write, io } = opts;
  const git: GitOpts = { cwd: ctx.repoPath, env: ctx.env };
  seedIfEmpty(record);
  const hasGh = ghAvailable(git);
  const remote = hasOrigin(git);
  resolveDefaultBranch(record, git, hasGh);

  const items = loadStackItems(record);
  let item = currentStackItem(record);
  if (!item) {
    return { record, hint: "stack complete", item: lastPr(record) };
  }

  if (localCompleteWithoutGh(item, hasGh, remote)) {
    noteGhMissing(io);
    const next = nextWorkItem(record, hasGh, remote);
    if (!next) {
      return { record, hint: "stack complete", item };
    }
    item = next;
  }

  const base = () => resolveStackBase(record, item, items);

  if (item.phase === "none") {
    gitFetchOrigin(git);
    item.phase = "fetched";
    touch(record);
    await write(record);
  }

  if (item.phase === "fetched") {
    if (isDirty(git)) {
      throw new PluginError("usage", "worktree is dirty");
    }
    gitCheckoutBranch(base(), item.branch, git);
    item.phase = "checked_out";
    record.resume_step_id = firstItemStep(record, item);
    touch(record);
    await write(record);
    return { record, hint: "run devkit implement", item };
  }

  if (item.phase === "checked_out") {
    if (!itemStepsTerminal(record, item)) {
      throw new PluginError(
        "usage",
        `finish stack item ${item.stack_id} steps first`,
      );
    }
    const paths = unionAllowedPaths(record, item);
    if (paths.length === 0) {
      throw new PluginError(
        "usage",
        `stack item ${item.stack_id} has no allowed_paths`,
      );
    }
    const head = gitCurrentBranch(git);
    if (head !== item.branch) {
      throw new PluginError(
        "usage",
        `worktree is not on stack branch ${item.branch}`,
      );
    }
    const identity = gitIdentity(git);
    gitAddPaths(paths, git);
    item.commit_sha = gitCommit(itemTitle(record, item, items), identity, git);
    item.phase = "committed";
    touch(record);
    await write(record);
  }

  if (item.phase === "committed") {
    if (remote) {
      gitPushBranch(item.branch, git);
      item.phase = "pushed";
      touch(record);
      await write(record);
    }
  }

  if (item.phase === "pushed") {
    if (!hasGh) {
      noteGhMissing(io);
      return { record, hint: moreHint(record, hasGh, remote), item };
    }
    const created = ghCreatePr(
      {
        base: base(),
        head: item.branch,
        title: itemTitle(record, item, items),
        body: `Stacked pull request ${item.stack_id}.`,
      },
      git,
    );
    if (created.missing) {
      noteGhMissing(io);
      return { record, hint: moreHint(record, hasGh, remote), item };
    }
    item.pr_url = created.pr.url;
    item.pr_number = created.pr.number;
    item.pr_state = "created";
    item.phase = "pr_created";
    touch(record);
    await write(record);
    logPlugin(ctx.env, {
      event: "plugin.stack.create",
      repo_id: ctx.repoId,
      result: "created",
    });
    return {
      record,
      hint: moreHint(record, hasGh, remote),
      item,
    };
  }

  if (!hasGh) {
    noteGhMissing(io);
    return { record, hint: moreHint(record, hasGh, remote), item };
  }
  return { record, hint: "run devkit stack publish", item };
}
