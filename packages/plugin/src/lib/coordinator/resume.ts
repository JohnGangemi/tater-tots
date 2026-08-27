import {
  TERMINAL,
  type CoordinatorRecord,
  type StackPr,
  type StepStatus,
} from "./types.js";

function currentStackItem(record: CoordinatorRecord): StackPr | undefined {
  return record.stack.prs.find((p) => p.phase !== "pr_created");
}

function firstNonTerminal(record: CoordinatorRecord): string | null {
  let pool = record.steps;
  if (record.stack.enabled) {
    const item = currentStackItem(record);
    if (!item) {
      return null;
    }
    pool = record.steps.filter((s) => s.stack_id === item.stack_id);
  }
  const next = pool.find((s) => !TERMINAL.has(s.status));
  return next?.id ?? null;
}

/** Resume id is the step to run now, not last completed + 1. */
export function resumeStep(record: CoordinatorRecord): string | null {
  const byId = record.resume_step_id
    ? record.steps.find((s) => s.id === record.resume_step_id)
    : undefined;
  if (
    byId &&
    (byId.status === "pending" ||
      byId.status === "in_progress" ||
      byId.status === "blocked")
  ) {
    return byId.id;
  }
  return firstNonTerminal(record);
}

export function resumeAfterMark(
  record: CoordinatorRecord,
  stepId: string,
  status: StepStatus,
): string | null {
  if (
    status === "pending" ||
    status === "in_progress" ||
    status === "blocked"
  ) {
    return stepId;
  }
  const next: CoordinatorRecord = { ...record, resume_step_id: stepId };
  return firstNonTerminal(next);
}
