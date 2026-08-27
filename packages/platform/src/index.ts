export { createContext, type CreateContextOpts, type PlatformContext } from "./lib/context.js";
export {
  loadConfig,
  SHIPPED_DEFAULTS,
  type Config,
  type LoadConfigOpts,
  type VerificationLevel,
} from "./lib/config.js";
export { resolveRepoId, normalizeOriginUrl, hashSource, type RepoIdentity } from "./lib/repo-id.js";
export {
  userDataPaths,
  resolveDataRoot,
  resolveDevkitHome,
  joinDevkitHome,
  type DevkitPaths,
} from "./lib/paths.js";
export { PlatformError, type ErrorCode } from "./lib/errors.js";
export { initGraph, formatInitStdout, type InitOpts, type InitResult } from "./lib/graph/init.js";
export {
  graphSearch,
  graphSymbol,
  graphImpact,
  type GraphSearchIn,
  type GraphSearchOut,
  type GraphSymbolIn,
  type GraphSymbolOut,
  type GraphImpactIn,
  type GraphImpactOut,
} from "./lib/graph/tools.js";
export type { Hit } from "./lib/graph/parse.js";
export {
  playbookLookup,
  playbookRecord,
  playbook_record,
  playbookList,
  playbookStats,
  type LookupIn,
  type LookupOut,
  type ObserveEvent,
  type PlaybookEntry,
  type PlaybookFile,
  type PlaybookRecordResult,
  type PlaybookStatsOut,
  type PurposeTag,
} from "./lib/playbook/store.js";
export {
  evidenceCheck,
  evidence_check,
  type EvidenceInput,
  type EvidenceResult,
  type EvidenceVerdict,
} from "./lib/evidence/check.js";
export { adversarialReview } from "./lib/adversarial/review.js";
export type {
  AdversarialInput,
  AdversarialResult,
  EvidenceType,
  Finding,
  FindingTag,
  Verdict,
} from "./lib/adversarial/types.js";
export {
  ingestProgress,
  recordSignal,
  tuneAccept,
  tuneReject,
  tuneRevert,
  tuneShow,
  tuneStatus,
  writeProposal,
} from "./lib/tune/store.js";
export type { Proposal, Signal, SignalKind, TuneStatusOut } from "./lib/tune/types.js";
