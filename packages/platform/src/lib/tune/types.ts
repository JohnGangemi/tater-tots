export const SIGNAL_KINDS = [
  "evidence_fail_then_success",
  "adversarial_patch_pattern",
  "step_blocked_then_completed",
  "skill_skipped",
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type Signal = {
  at: string;
  kind: SignalKind;
  fact: Record<string, string>;
};

export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "reverted"] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type Proposal = {
  id: string;
  skill: string;
  created_at: string;
  status: ProposalStatus;
  source_facts: Signal[];
  repeats: number;
  window_runs: number;
  override_md: string;
};

export type TuneStatusOut = {
  pending: string[];
  auto_accept: boolean;
};

export const DEFAULT_TUNE_SKILL = "using-coredevkit";
export const OVERRIDE_MD_MAX_LINES = 40;
export const PROPOSAL_ID_RE = /^tp-\d{8}-[0-9a-f]{8}$/;
export const PROPOSAL_ID_MAX = 64;

export const FACT_KEYS: Record<SignalKind, readonly string[]> = {
  evidence_fail_then_success: ["purpose", "failed_key", "success_key"],
  adversarial_patch_pattern: ["category", "tag", "pattern_hash"],
  step_blocked_then_completed: ["step_title", "command_key"],
  skill_skipped: ["skill"],
};

export const REQUIRED_FACT_KEYS: Record<SignalKind, readonly string[]> = {
  evidence_fail_then_success: ["purpose", "failed_key", "success_key"],
  adversarial_patch_pattern: ["category", "tag", "pattern_hash"],
  step_blocked_then_completed: ["step_title"],
  skill_skipped: ["skill"],
};
