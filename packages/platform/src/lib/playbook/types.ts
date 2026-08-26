export type PurposeTag = "test" | "build" | "lint" | "migrate" | "publish" | "run" | "other";

export type PlaybookEntry = {
  key: string;
  command: string;
  argv: string[];
  purpose_tags: PurposeTag[];
  cwd_rel: string | null;
  last_status: "pass" | "fail";
  last_exit: number;
  last_duration_ms: number;
  last_run_at: string;
  first_seen_at: string;
  lru_at: string;
  run_count: number;
  fail_count: number;
};

export type PlaybookFile = {
  version: 1;
  repo_id: string;
  updated_at: string;
  entries: PlaybookEntry[];
};

export type ObserveEvent = {
  raw_command?: string;
  tool_name: string;
  cwd: string;
  exit_code: number | null;
  duration_ms: number | null;
  session_id?: string;
};

export type LookupIn = {
  purpose?: string;
  prefix?: string;
};

export type LookupHit = {
  command: string;
  last_status: "pass" | "fail";
  last_exit: number;
  run_count: number;
  purpose_tags: PurposeTag[];
};

export type LookupOut = {
  commands: LookupHit[];
};

export type PlaybookRecordResult = {
  result: "stored" | "excluded" | "redacted";
};

export type PlaybookStatsOut = {
  entries: number;
  max_entries: number;
  filter: string;
  last_updated: string | null;
  by_purpose: Record<PurposeTag, number>;
  pass: number;
  fail: number;
};

export const PURPOSE_TAGS: PurposeTag[] = [
  "test",
  "build",
  "lint",
  "migrate",
  "publish",
  "run",
  "other",
];

export const LOOKUP_CAP = 5;
export const SHOW_DEFAULT = 20;
export const SHOW_MAX = 100;
export const COMMAND_SHOW_MAX = 80;
