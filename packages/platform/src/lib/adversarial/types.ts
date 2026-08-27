export type FindingTag = "patch-plan" | "block" | "note";
export type EvidenceType = "graph" | "filesystem" | "playbook" | "none";
export type Verdict = "BLOCK" | "PATCH" | "PASS";

export type AdversarialInput = {
  plan_path: string;
};

export type Finding = {
  id: string;
  tag: FindingTag;
  category: string;
  claim: string;
  evidence_type: EvidenceType;
  evidence: string;
  plan_target: string;
  patch: string | null;
};

export type AdversarialResult = {
  verdict: Verdict;
  findings: Finding[];
  dropped_illegal: number;
  plan_path: string;
  graph_ready: boolean;
  resolved_level: "off" | "light" | "full";
};

export const FINDING_CAP = 7;
