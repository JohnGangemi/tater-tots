import { PluginError } from "../errors.js";
import type { PlanIntent, Process, StackItem } from "./intent.js";

const SUMMARY_MAX = 500;
const GOAL_MAX = 2000;
const DETAIL_MAX = 2000;
const FENCE_RE = /```/;

export function processIsComplete(process: Process): boolean {
  return process.steps.length >= 1 && process.steps.every((s) => s.required);
}

function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkStrings(item, visit);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      walkStrings(v, visit);
    }
  }
}

function topoOrThrow(items: StackItem[]): void {
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) {
    throw new PluginError("usage", "stack id must be unique");
  }
  for (const item of items) {
    for (const dep of item.depends_on) {
      if (!ids.has(dep)) {
        throw new PluginError(
          "usage",
          `stack ${item.id} depends_on unknown id ${dep}`,
        );
      }
      if (dep === item.id) {
        throw new PluginError("usage", `stack ${item.id} depends on itself`);
      }
    }
  }
  const incoming = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const item of items) {
    incoming.set(item.id, 0);
    outs.set(item.id, []);
  }
  for (const item of items) {
    for (const dep of item.depends_on) {
      outs.get(dep)?.push(item.id);
      incoming.set(item.id, (incoming.get(item.id) ?? 0) + 1);
    }
  }
  const q = items
    .filter((i) => (incoming.get(i.id) ?? 0) === 0)
    .map((i) => i.id);
  let seen = 0;
  while (q.length > 0) {
    const id = q.shift();
    if (!id) {
      break;
    }
    seen += 1;
    for (const next of outs.get(id) ?? []) {
      const n = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, n);
      if (n === 0) {
        q.push(next);
      }
    }
  }
  if (seen !== items.length) {
    throw new PluginError("usage", "stack depends_on has a cycle");
  }
}

export function validateIntent(
  intent: PlanIntent,
  opts?: { htmlCodeBlocks?: boolean },
): void {
  if (intent.summary.length > SUMMARY_MAX) {
    throw new PluginError("usage", "intent summary exceeds 500 characters");
  }
  if (intent.goal.length > GOAL_MAX) {
    throw new PluginError("usage", "intent goal exceeds 2000 characters");
  }

  for (const process of intent.processes) {
    for (const step of process.steps) {
      if (step.detail.length > DETAIL_MAX) {
        throw new PluginError(
          "usage",
          `process ${process.id} step ${step.id} detail exceeds 2000 characters`,
        );
      }
    }
    const complete = processIsComplete(process);
    if (process.complete && !complete) {
      throw new PluginError(
        "usage",
        `process ${process.id} complete is true but steps are empty or not all required`,
      );
    }
    if (!process.complete && complete) {
      throw new PluginError(
        "usage",
        `process ${process.id} complete is false but all steps are required`,
      );
    }
  }

  const processById = new Map(intent.processes.map((p) => [p.id, p]));
  for (const seq of intent.sequences) {
    if (!seq.process_id) {
      continue;
    }
    const process = processById.get(seq.process_id);
    if (!process) {
      throw new PluginError(
        "usage",
        `sequence ${seq.id} process_id ${seq.process_id} is unknown`,
      );
    }
    const stepIds = new Set(process.steps.map((s) => s.id));
    for (const id of seq.step_ids) {
      if (!stepIds.has(id)) {
        throw new PluginError(
          "usage",
          `sequence ${seq.id} step ${id} is not in process ${seq.process_id}`,
        );
      }
    }
  }

  const qids = new Set<string>();
  for (const q of intent.open_questions) {
    if (qids.has(q.id)) {
      throw new PluginError("usage", `open_questions id ${q.id} is not unique`);
    }
    qids.add(q.id);
    if (q.status === "resolved") {
      if (!q.answer || q.answer.trim() === "") {
        throw new PluginError(
          "usage",
          `open_questions ${q.id} resolved requires a non-empty answer`,
        );
      }
    }
    if (q.status === "open" && q.answer !== null) {
      throw new PluginError(
        "usage",
        `open_questions ${q.id} open requires answer null`,
      );
    }
  }

  topoOrThrow(intent.stack);

  if (!opts?.htmlCodeBlocks) {
    walkStrings(intent, (s) => {
      if (FENCE_RE.test(s)) {
        throw new PluginError(
          "usage",
          "intent must not contain implementation fences",
        );
      }
    });
  }
}
