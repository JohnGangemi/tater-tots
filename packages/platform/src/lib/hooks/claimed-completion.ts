import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const TRANSCRIPT_TAIL_BYTES = 8192;

/** Whole-word claims only; a substring like "not done" must not fire evidence-on-stop. */
export const CLAIMED_COMPLETION_RE =
  /\b(all (done|complete)|that's all|that is all|ready for review|pr is ready|tests pass(ed)?|i('m| am) done|finished the (task|work|implementation))\b/i;

export type ClaimedCompletionInput = {
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  transcriptPath?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function assistantTextFromRow(row: unknown): string {
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

function readTranscriptTail(path: string): string {
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
    const lines = buf.toString("utf8").split(/\r?\n/);
    let last = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const text = assistantTextFromRow(JSON.parse(trimmed) as unknown);
        if (text.trim()) {
          last = text;
        }
      } catch {
        // Tail may start mid-line; skip the broken JSONL row.
      }
    }
    return last;
  } catch {
    return "";
  }
}

export function isClaimedCompletion(input: ClaimedCompletionInput): boolean {
  if (input.stopHookActive === true) {
    return false;
  }
  const direct = input.lastAssistantMessage?.trim() ?? "";
  const text = direct || (input.transcriptPath ? readTranscriptTail(input.transcriptPath) : "");
  if (!text) {
    return false;
  }
  return CLAIMED_COMPLETION_RE.test(text);
}
