import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { applyUserOnlyFileSync, mkdirUserOnlySync } from "../fs-atomic.js";
import { dirname } from "node:path";
import {
  FACT_KEYS,
  REQUIRED_FACT_KEYS,
  SIGNAL_KINDS,
  type Signal,
  type SignalKind,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSignalKind(value: unknown): value is SignalKind {
  return typeof value === "string" && (SIGNAL_KINDS as readonly string[]).includes(value);
}

export function pickFact(kind: SignalKind, raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FACT_KEYS[kind]) {
    const v = raw[key];
    if (typeof v === "string" && v.length > 0) {
      out[key] = v;
    }
  }
  return out;
}

export function factComplete(kind: SignalKind, fact: Record<string, string>): boolean {
  return REQUIRED_FACT_KEYS[kind].every((key) => Boolean(fact[key]));
}

export function parseSignal(value: unknown): Signal | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const at = value.at;
  const kind = value.kind;
  if (typeof at !== "string" || !at || !isSignalKind(kind)) {
    return undefined;
  }
  if (!isPlainObject(value.fact)) {
    return undefined;
  }
  const fact = pickFact(kind, value.fact);
  if (!factComplete(kind, fact)) {
    return undefined;
  }
  return { at, kind, fact };
}

export function parseSignalLine(line: string): Signal | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return parseSignal(JSON.parse(trimmed) as unknown);
  } catch {
    return undefined;
  }
}

export function readSignals(file: string): Signal[] {
  if (!existsSync(file)) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Signal[] = [];
  for (const line of text.split(/\r?\n/)) {
    const sig = parseSignalLine(line);
    if (sig) {
      out.push(sig);
    }
  }
  return out;
}

export function appendSignal(file: string, signal: Signal): void {
  mkdirUserOnlySync(dirname(file));
  appendFileSync(file, `${JSON.stringify(signal)}\n`, { encoding: "utf8", mode: 0o600 });
  applyUserOnlyFileSync(file);
}

export function groupKey(signal: Signal): string {
  switch (signal.kind) {
    case "evidence_fail_then_success":
      return [
        signal.kind,
        signal.fact.purpose ?? "",
        signal.fact.failed_key ?? "",
        signal.fact.success_key ?? "",
      ].join("\t");
    case "adversarial_patch_pattern":
      return [
        signal.kind,
        signal.fact.category ?? "",
        signal.fact.tag ?? "",
        signal.fact.pattern_hash ?? "",
      ].join("\t");
    case "step_blocked_then_completed":
      return [signal.kind, signal.fact.step_title ?? "", signal.fact.command_key ?? ""].join("\t");
    case "skill_skipped":
      return [signal.kind, signal.fact.skill ?? ""].join("\t");
    default: {
      const _never: never = signal.kind;
      return _never;
    }
  }
}

export function sameFact(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}
