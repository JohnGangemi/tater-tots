import { FINDING_CAP, type Finding, type FindingTag, type Verdict } from "./types.js";

export { FINDING_CAP } from "./types.js";
export type {
  AdversarialInput,
  AdversarialResult,
  EvidenceType,
  Finding,
  FindingTag,
  Verdict,
} from "./types.js";

const TAG_RANK: Record<FindingTag, number> = {
  block: 0,
  "patch-plan": 1,
  note: 2,
};

export function isIllegalPair(finding: Finding): boolean {
  return (
    (finding.tag === "patch-plan" || finding.tag === "block") && finding.evidence_type === "none"
  );
}

function cmpFinding(a: Finding, b: Finding): number {
  const tag = TAG_RANK[a.tag] - TAG_RANK[b.tag];
  if (tag !== 0) {
    return tag;
  }
  if (a.category < b.category) {
    return -1;
  }
  if (a.category > b.category) {
    return 1;
  }
  if (a.claim < b.claim) {
    return -1;
  }
  if (a.claim > b.claim) {
    return 1;
  }
  if (a.plan_target < b.plan_target) {
    return -1;
  }
  if (a.plan_target > b.plan_target) {
    return 1;
  }
  return 0;
}

function assignIds(findings: Finding[]): Finding[] {
  return findings.map((f, i) => ({
    ...f,
    id: `AR-${String(i + 1).padStart(3, "0")}`,
  }));
}

export function verdictOf(findings: Finding[]): Verdict {
  if (findings.some((f) => f.tag === "block")) {
    return "BLOCK";
  }
  if (findings.some((f) => f.tag === "patch-plan")) {
    return "PATCH";
  }
  return "PASS";
}

export function applyFindingContract(findings: Finding[]): {
  findings: Finding[];
  dropped_illegal: number;
  verdict: Verdict;
} {
  const dropped_illegal = findings.filter(isIllegalPair).length;
  const legal = findings.filter((f) => !isIllegalPair(f)).sort(cmpFinding);
  const capped = assignIds(legal.slice(0, FINDING_CAP));
  return {
    findings: capped,
    dropped_illegal,
    verdict: verdictOf(capped),
  };
}
