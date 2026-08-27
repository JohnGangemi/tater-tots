import { PluginError } from "../errors.js";
import type { StackItem } from "../plan/intent.js";
import type { CoordinatorStep, StackPr } from "./types.js";

export function topoStackItems(items: StackItem[]): StackItem[] {
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
  const ready = items
    .filter((i) => (incoming.get(i.id) ?? 0) === 0)
    .map((i) => i.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const order: StackItem[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) {
      break;
    }
    const item = byId.get(id);
    if (item) {
      order.push(item);
    }
    for (const next of outs.get(id) ?? []) {
      const n = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, n);
      if (n === 0) {
        ready.push(next);
      }
    }
  }
  if (order.length !== items.length) {
    throw new PluginError("usage", "stack depends_on has a cycle");
  }
  return order;
}

function allowedFor(stepIds: string[], steps: CoordinatorStep[]): string[] {
  const set = new Set(stepIds);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (!set.has(step.id)) {
      continue;
    }
    for (const p of step.allowed_paths) {
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

function prFromItem(item: StackItem, steps: CoordinatorStep[]): StackPr {
  return {
    stack_id: item.id,
    branch: item.branch,
    base: item.base,
    pr_number: null,
    pr_url: null,
    pr_state: "none",
    phase: "none",
    commit_sha: null,
    allowed_paths: allowedFor(item.step_ids, steps),
  };
}

export function applyStackIds(
  steps: CoordinatorStep[],
  items: StackItem[],
): CoordinatorStep[] {
  const byStep = new Map<string, string>();
  for (const item of items) {
    for (const id of item.step_ids) {
      byStep.set(id, item.id);
    }
  }
  for (const step of steps) {
    const fromIntent = byStep.get(step.id);
    if (fromIntent) {
      step.stack_id = fromIntent;
    }
  }
  return steps;
}

export function seedStackPrs(
  items: StackItem[],
  steps: CoordinatorStep[],
  existingPrs: StackPr[],
): StackPr[] {
  const ordered = items.length > 0 ? topoStackItems(items) : [];
  const wanted = new Map(ordered.map((i) => [i.id, i]));

  if (existingPrs.length === 0) {
    return ordered.map((item) => prFromItem(item, steps));
  }

  const out: StackPr[] = [];
  const seen = new Set<string>();
  for (const prev of existingPrs) {
    const next = wanted.get(prev.stack_id);
    if (!next) {
      if (prev.phase !== "none") {
        out.push(prev);
      }
      continue;
    }
    seen.add(prev.stack_id);
    if (prev.phase === "none") {
      out.push({
        ...prev,
        branch: next.branch,
        base: next.base,
        allowed_paths: allowedFor(next.step_ids, steps),
      });
    } else {
      out.push(prev);
    }
  }
  for (const item of ordered) {
    if (seen.has(item.id)) {
      continue;
    }
    out.push(prFromItem(item, steps));
  }
  return out;
}

export function assertStackPrs(enabled: boolean, prs: StackPr[]): void {
  if (enabled && prs.length === 0) {
    throw new PluginError("usage", "stack.enabled but stack.prs is empty");
  }
}
