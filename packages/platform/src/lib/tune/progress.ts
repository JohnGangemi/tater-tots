import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type ProgressRecord = {
  step_title: string;
  status: string;
  command_key?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only step_title, status, and optional command_key. Skip other fields. */
function asRecord(value: unknown): ProgressRecord | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const step_title = value.step_title;
  const status = value.status;
  if (typeof step_title !== "string" || step_title.length === 0) {
    return undefined;
  }
  if (typeof status !== "string" || status.length === 0) {
    return undefined;
  }
  const command_key = value.command_key;
  if (typeof command_key === "string" && command_key.length > 0) {
    return { step_title, status, command_key };
  }
  return { step_title, status };
}

function collect(value: unknown): ProgressRecord[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collect);
  }
  const self = asRecord(value);
  if (self) {
    return [self];
  }
  if (!isPlainObject(value)) {
    return [];
  }
  const out: ProgressRecord[] = [];
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isPlainObject(nested)) {
      out.push(...collect(nested));
    }
  }
  return out;
}

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // YAML may also start with { or [
    }
  }
  try {
    return parseYaml(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function readFileRecords(file: string): ProgressRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return collect(parseBody(text));
}

/** Read-only. Do not create this directory. */
export function readProgressRecords(progressDir: string): ProgressRecord[] {
  if (!existsSync(progressDir)) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(progressDir).sort();
  } catch {
    return [];
  }
  const out: ProgressRecord[] = [];
  for (const name of names) {
    const file = join(progressDir, name);
    try {
      if (!statSync(file).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    out.push(...readFileRecords(file));
  }
  return out;
}

export type ProgressTransition = {
  step_title: string;
  command_key?: string;
};

/** A signal fires only when blocked is later seen as done or done_by_user. */
export function blockedThenCompleted(records: ProgressRecord[]): ProgressTransition[] {
  const blocked = new Map<string, ProgressRecord>();
  const hits: ProgressTransition[] = [];
  for (const rec of records) {
    if (rec.status === "blocked") {
      blocked.set(rec.step_title, rec);
      continue;
    }
    if (rec.status !== "done" && rec.status !== "done_by_user") {
      continue;
    }
    const prior = blocked.get(rec.step_title);
    if (!prior) {
      continue;
    }
    blocked.delete(rec.step_title);
    const command_key = rec.command_key ?? prior.command_key;
    if (command_key) {
      hits.push({ step_title: rec.step_title, command_key });
    } else {
      hits.push({ step_title: rec.step_title });
    }
  }
  return hits;
}
