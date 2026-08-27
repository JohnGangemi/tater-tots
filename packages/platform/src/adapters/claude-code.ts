export const STOP_USER_REMINDER =
  "CoreDevKit: verification is on. Call evidence_check before claiming done.";

export type HookKind = "session-start" | "post-tool-use" | "stop";

export type ClaudeHookInput = {
  cwd: string;
  sessionId: string;
  hookEventName: string;
  toolName: string;
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  stopHookActive: boolean;
  lastAssistantMessage: string;
  transcriptPath: string;
  skills: string[];
  raw: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(obj[key]).trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const t = value.trim();
    return t ? [t] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    } else if (isPlainObject(item)) {
      const name = firstString(item, ["name", "skill", "skill_name", "id"]);
      if (name) {
        out.push(name);
      }
    }
  }
  return out;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function collectSkills(raw: Record<string, unknown>): string[] {
  const names = [
    ...asStringList(raw.skill_name),
    ...asStringList(raw.skillName),
    ...asStringList(raw.loaded_skills),
    ...asStringList(raw.loadedSkills),
    ...asStringList(raw.skills),
  ];
  return [...new Set(names)];
}

function toolInput(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = raw.tool_input ?? raw.toolInput;
  return isPlainObject(value) ? value : undefined;
}

function toolResponse(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = raw.tool_response ?? raw.toolResponse;
  return isPlainObject(value) ? value : undefined;
}

function commandFrom(raw: Record<string, unknown>): string {
  const input = toolInput(raw);
  if (input) {
    const cmd = firstString(input, ["command", "cmd"]);
    if (cmd) {
      return cmd;
    }
  }
  return firstString(raw, ["command", "cmd", "raw_command"]);
}

function exitFrom(raw: Record<string, unknown>): number | null {
  const resp = toolResponse(raw);
  const n =
    asFiniteNumber(raw.exit_code) ??
    asFiniteNumber(raw.exitCode) ??
    asFiniteNumber(raw.exit) ??
    (resp
      ? (asFiniteNumber(resp.exitCode) ??
        asFiniteNumber(resp.exit_code) ??
        asFiniteNumber(resp.exit))
      : undefined);
  return n === undefined ? null : n;
}

function durationFrom(raw: Record<string, unknown>): number | null {
  const resp = toolResponse(raw);
  const n =
    asFiniteNumber(raw.duration_ms) ??
    asFiniteNumber(raw.durationMs) ??
    asFiniteNumber(raw.duration) ??
    (resp ? (asFiniteNumber(resp.duration_ms) ?? asFiniteNumber(resp.durationMs)) : undefined);
  return n === undefined ? null : n;
}

export function parseClaudeHookInput(raw: unknown): ClaudeHookInput | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const cwd = firstString(raw, ["cwd", "CWD"]);
  if (!cwd) {
    return undefined;
  }
  return {
    cwd,
    sessionId: firstString(raw, ["session_id", "sessionId"]),
    hookEventName: firstString(raw, ["hook_event_name", "hookEventName"]),
    toolName: firstString(raw, ["tool_name", "toolName"]),
    command: commandFrom(raw),
    exitCode: exitFrom(raw),
    durationMs: durationFrom(raw),
    stopHookActive: asBool(raw.stop_hook_active) || asBool(raw.stopHookActive),
    lastAssistantMessage: firstString(raw, [
      "last_assistant_message",
      "lastAssistantMessage",
      "last_assistant_text",
    ]),
    transcriptPath: firstString(raw, ["transcript_path", "transcriptPath"]),
    skills: collectSkills(raw),
    raw,
  };
}

export function formatSessionStartOutput(pointer: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: pointer,
    },
  })}\n`;
}

export function formatStopUserReminder(): string {
  return `${JSON.stringify({ systemMessage: STOP_USER_REMINDER })}\n`;
}

export function formatStopBlock(reason: string): string {
  // additionalContext on Stop continues the turn; never include it.
  return `${JSON.stringify({ decision: "block", reason })}\n`;
}
