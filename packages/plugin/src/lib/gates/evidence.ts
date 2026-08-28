import type {
  EvidenceInput,
  EvidenceResult,
  EvidenceVerdict,
  PlatformContext,
  PlaybookEntry,
} from "@coredevkit/platform";
import type { CoordinatorStep } from "../coordinator/types.js";

export type EvidenceFns = {
  evidenceCheck: (
    ctx: PlatformContext,
    input: EvidenceInput,
  ) => Promise<EvidenceResult>;
  playbookList: (
    ctx: PlatformContext,
    limit: number,
  ) => Promise<PlaybookEntry[]>;
};

const RUNNERS = new Set([
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "node",
  "python",
  "python3",
  "pytest",
  "cargo",
  "go",
  "make",
  "deno",
]);

export function evidenceGateExit(result: {
  ok: boolean;
  verdict: EvidenceVerdict;
}): number {
  if (result.ok) {
    return 0;
  }
  if (result.verdict === "error") {
    return 3;
  }
  if (
    result.verdict === "fail" ||
    result.verdict === "no_command" ||
    result.verdict === "denied"
  ) {
    return 2;
  }
  if (result.verdict === "pass" || result.verdict === "skipped") {
    return 0;
  }
  return 2;
}

export function looksLikeArgv(text: string): boolean {
  if (text.includes(" ")) {
    return true;
  }
  const base = text.split(/[\\/]/).pop() ?? text;
  return RUNNERS.has(base.toLowerCase());
}

export type EvidenceBeforeDoneInput = EvidenceFns & {
  ctx: PlatformContext;
  step: CoordinatorStep;
  evidenceCommand?: string;
  evidencePurpose?: string;
  forceEvidence: boolean;
};

export async function evidenceBeforeDone(
  input: EvidenceBeforeDoneInput,
): Promise<EvidenceResult> {
  const force = input.forceEvidence;
  if (input.evidenceCommand) {
    return input.evidenceCheck(input.ctx, {
      command: input.evidenceCommand,
      force,
    });
  }
  if (input.evidencePurpose) {
    return input.evidenceCheck(input.ctx, {
      purpose: input.evidencePurpose,
      force,
    });
  }
  const entries = await input.playbookList(
    input.ctx,
    input.ctx.config.playbook.max_entries,
  );
  const key = input.step.command_key;
  if (key) {
    const entry = entries.find((e) => e.key === key);
    if (entry && (entry.last_status !== "fail" || force)) {
      return input.evidenceCheck(input.ctx, {
        command: entry.command,
        argv: entry.argv,
        force,
      });
    }
    if (looksLikeArgv(key)) {
      return input.evidenceCheck(input.ctx, { command: key, force });
    }
  }
  return input.evidenceCheck(input.ctx, { purpose: "test", force });
}
