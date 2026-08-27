import { lastAssistantTextFromTranscript } from "./transcript.js";

/** Whole-word claims only; a substring like "not done" must not fire evidence-on-stop. */
export const CLAIMED_COMPLETION_RE =
  /\b(all (done|complete)|that's all|that is all|ready for review|pr is ready|tests pass(ed)?|i('m| am) done|finished the (task|work|implementation))\b/i;

export type ClaimedCompletionInput = {
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  transcriptPath?: string;
};

export function isClaimedCompletion(input: ClaimedCompletionInput): boolean {
  if (input.stopHookActive === true) {
    return false;
  }
  const direct = input.lastAssistantMessage?.trim() ?? "";
  const text =
    direct || (input.transcriptPath ? lastAssistantTextFromTranscript(input.transcriptPath) : "");
  if (!text) {
    return false;
  }
  return CLAIMED_COMPLETION_RE.test(text);
}
