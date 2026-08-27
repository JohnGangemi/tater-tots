import {
  TERMINAL,
  type CoordinatorRecord,
  type StackPr,
  type StepStatus,
} from "./types.js";

export type StackSkipOpts = {
  hasGh: boolean;
  hasRemote: boolean;
};

/** Leftover pushed (or committed with no remote) is complete when gh is missing. */
export function stackItemComplete(
  item: StackPr,
  skip?: StackSkipOpts,
): boolean {
  if (item.phase === "pr_created") {
    return true;
  }
  if (!skip || skip.hasGh) {
    return false;
  }
  if (item.phase === "pushed") {
    return true;
  }
  return item.phase === "committed" && !skip.hasRemote;
}

/** Current item is the first row that is not complete for this skip. */
export function currentStackItem(
  record: CoordinatorRecord,
  skip?: StackSkipOpts,
): StackPr | undefined {
  if (!record.stack.enabled) {
    return undefined;
  }
  return record.stack.prs.find((p) => !stackItemComplete(p, skip));
}

function stepsOnItem(
  record: CoordinatorRecord,
  item: StackPr,
): CoordinatorRecord["steps"] {
  return record.steps.filter((s) => s.stack_id === item.stack_id);
}

function firstNonTerminal(
  record: CoordinatorRecord,
  skip?: StackSkipOpts,
): string | null {
  if (record.stack.enabled) {
    const item = currentStackItem(record, skip);
    if (!item) {
      return null;
    }
    return (
      stepsOnItem(record, item).find((s) => !TERMINAL.has(s.status))?.id ?? null
    );
  }
  return record.steps.find((s) => !TERMINAL.has(s.status))?.id ?? null;
}

/** Resume id is the step to run now, not last completed + 1. */
export function resumeStep(
  record: CoordinatorRecord,
  skip?: StackSkipOpts,
): string | null {
  const byId = record.resume_step_id
    ? record.steps.find((s) => s.id === record.resume_step_id)
    : undefined;
  if (
    byId &&
    (byId.status === "pending" ||
      byId.status === "in_progress" ||
      byId.status === "blocked")
  ) {
    if (!record.stack.enabled || !skip) {
      return byId.id;
    }
    const item = currentStackItem(record, skip);
    if (!item || byId.stack_id === item.stack_id) {
      return byId.id;
    }
  }
  return firstNonTerminal(record, skip);
}

export function resumeAfterMark(
  record: CoordinatorRecord,
  stepId: string,
  status: StepStatus,
  skip?: StackSkipOpts,
): string | null {
  if (
    status === "pending" ||
    status === "in_progress" ||
    status === "blocked"
  ) {
    return stepId;
  }
  const next: CoordinatorRecord = { ...record, resume_step_id: stepId };
  return firstNonTerminal(next, skip);
}
