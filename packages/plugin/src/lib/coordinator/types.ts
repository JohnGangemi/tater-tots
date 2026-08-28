export const STEP_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "blocked",
  "done_by_user",
  "skipped",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ADVERSARIAL_STATUSES = ["skipped", "passed", "blocked"] as const;
export type AdversarialStatus = (typeof ADVERSARIAL_STATUSES)[number];

export const TERMINAL: ReadonlySet<StepStatus> = new Set([
  "done",
  "done_by_user",
  "skipped",
]);

export type EvidenceSnap = {
  ok: boolean;
  verdict: "pass" | "fail" | "no_command" | "denied" | "error" | "skipped";
  command: string | null;
  attempts: number;
  recorded: "stored" | "excluded" | "redacted" | "skipped";
  at: string;
};

export type StepSummary = {
  role: string;
  agent: string;
  text: string;
  at: string;
};

export type ProgressEvent = {
  step_title: string;
  status: StepStatus;
  command_key?: string;
  at: string;
};

export type StackPhase =
  "none" | "fetched" | "checked_out" | "committed" | "pushed" | "pr_created";

export type StackPr = {
  stack_id: string;
  branch: string;
  base: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: "none" | "created" | "merged" | "closed";
  phase: StackPhase;
  commit_sha: string | null;
  allowed_paths: string[];
};

export type CoordinatorStep = {
  id: string;
  step_title: string;
  title: string;
  status: StepStatus;
  command_key?: string;
  allowed_paths: string[];
  evidence: EvidenceSnap | null;
  summaries: StepSummary[];
  blocked_reason: string | null;
  stack_id: string | null;
};

export type CoordinatorRecord = {
  version: 1;
  repo_id: string;
  worktree_hash: string;
  worktree_sha256: string;
  plan_id: string;
  plan_dir: string;
  intent_path: string;
  agent_plan: string;
  html_path: string;
  source: "plan" | "issue-to-pr";
  issue: { number: number; url: string; title: string } | null;
  pipeline_phase:
    | null
    | "read_issue"
    | "sow"
    | "draft_plan"
    | "refine"
    | "implement"
    | "branch_review"
    | "security_review"
    | "tests"
    | "publish"
    | "complete";
  created_at: string;
  updated_at: string;
  verification_level: "off" | "light" | "full";
  adversarial: {
    status: AdversarialStatus;
    verdict: "BLOCK" | "PATCH" | "PASS" | null;
    ran_at: string | null;
    session_id: string | null;
    findings_hash: string | null;
  };
  resume_step_id: string | null;
  blocking_open_question_ids: string[];
  stack: {
    enabled: boolean;
    default_branch: string | null;
    prs: StackPr[];
  };
  events: ProgressEvent[];
  steps: CoordinatorStep[];
};
