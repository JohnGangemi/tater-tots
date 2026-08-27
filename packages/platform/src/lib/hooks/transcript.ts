import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export const TRANSCRIPT_TAIL_BYTES = 8192;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTranscriptTail(path: string): string {
  if (!existsSync(path)) {
    return "";
  }
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
    const len = st.size - start;
    if (len <= 0) {
      return "";
    }
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

export function parseTranscriptRows(raw: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Tail may start mid-line; skip the broken JSONL row.
    }
  }
  return rows;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (isPlainObject(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

export function assistantTextFromRow(row: unknown): string {
  if (!isPlainObject(row)) {
    return "";
  }
  const isAssistant =
    row.type === "assistant" ||
    row.role === "assistant" ||
    (isPlainObject(row.message) && row.message.role === "assistant");
  if (!isAssistant) {
    return "";
  }
  const msg = isPlainObject(row.message) ? row.message : row;
  return textFromContent(msg.content);
}

function pushSkillToken(out: string[], raw: string): void {
  const t = raw.trim();
  if (!t) {
    return;
  }
  out.push(t);
  for (const part of t.split(/[:/@]/)) {
    if (part && part !== t) {
      out.push(part);
    }
  }
}

function skillTokensFromInput(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["skill", "skill_name", "command", "name"]) {
    const value = input[key];
    if (typeof value === "string") {
      pushSkillToken(out, value);
    }
  }
  return out;
}

function collectToolUses(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolUses(item, out);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  if (value.type === "tool_use" && typeof value.name === "string") {
    out.push(value);
  }
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) {
      collectToolUses(child, out);
    }
  }
}

export function skillNamesFromRow(row: unknown): string[] {
  const uses: Record<string, unknown>[] = [];
  collectToolUses(row, uses);
  const out: string[] = [];
  for (const block of uses) {
    if (String(block.name).toLowerCase() !== "skill") {
      continue;
    }
    if (isPlainObject(block.input)) {
      out.push(...skillTokensFromInput(block.input));
    }
  }
  return out;
}

export function lastAssistantTextFromTranscript(path: string): string {
  const rows = parseTranscriptRows(readTranscriptTail(path));
  let last = "";
  for (const row of rows) {
    const text = assistantTextFromRow(row);
    if (text.trim()) {
      last = text;
    }
  }
  return last;
}

export function skillNamesFromTranscript(path: string): string[] {
  const rows = parseTranscriptRows(readTranscriptTail(path));
  const names: string[] = [];
  for (const row of rows) {
    names.push(...skillNamesFromRow(row));
  }
  return [...new Set(names)];
}
