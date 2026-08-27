export { PluginError, isPluginError, pluginExitCode } from "./errors.js";
export {
  loadPlatform,
  PLATFORM_MISSING,
  type PlatformModule,
} from "./platform-guard.js";
export {
  loadPluginConfig,
  PLUGIN_SHIPPED_DEFAULTS,
  checkerName,
  type PluginConfig,
  type SubagentRole,
  type LoadPluginConfigOpts,
} from "./plugin-config.js";
export { writeProgressAtomic } from "./fs-user.js";
export { logPlugin } from "./log.js";
export { worktreeHash, type WorktreeId } from "./worktree.js";
export { loadSkillBody } from "./skill-runner.js";
export {
  loadCoordinator,
  saveCoordinator,
  markStep,
  progressFilePath,
  parseCoordinator,
  stringifyCoordinator,
  type CoordinatorOpts,
  type MarkStepOpts,
} from "./coordinator/store.js";
export { resumeStep, currentStackItem } from "./coordinator/resume.js";
export type {
  AdversarialStatus,
  CoordinatorRecord,
  CoordinatorStep,
  ProgressEvent,
  StackPr,
  StepStatus,
} from "./coordinator/types.js";
export {
  STEP_STATUSES,
  ADVERSARIAL_STATUSES,
  TERMINAL,
} from "./coordinator/types.js";
export { parsePlanMd, parsePlanMdSteps } from "./coordinator/parse-plan-md.js";
export { seedStackPrs, topoStackItems } from "./coordinator/seed-stack.js";
export {
  INTENT_VERSION,
  parseIntent,
  parseIntentJson,
  loadIntentFile,
  finalizeResolvedQuestions,
  needsPlanDesigner,
  type PlanIntent,
  type OpenQuestion,
  type Process,
  type StackItem,
  type IntentParseOpts,
} from "./plan/intent.js";
export { validateIntent, processIsComplete } from "./plan/validate.js";
export {
  renderPlanHtml,
  renderPlanHtmlFile,
  escapeHtml,
} from "./plan/render-html.js";
export { resolvePlanDir, planFilePaths } from "./plan/paths.js";
export { startCoordinator } from "./plan/start-coordinator.js";
export { runPlanCommand } from "./plan/command.js";
export type { RunPacket, SubagentPacket } from "./plan/packet.js";
export { runImplementCommand } from "./implement/command.js";
export { runStackCommand } from "./stack/command.js";
export {
  publishStack,
  resolveStackBase,
  unionAllowedPaths,
  GH_MISSING_MSG,
} from "./stack/create.js";
export { runDebugCommand } from "./debug/command.js";
export { runReviewCommand, collectDiffPaths } from "./review/command.js";
export { runFinishCommand } from "./finish/command.js";
export type { FinishPacket } from "./finish/command.js";
export { evidenceBeforeDone, evidenceGateExit } from "./gates/evidence.js";
export {
  shouldRunAdversarial,
  runAdversarialCheckpoint,
  acceptAdversarialPatch,
  newAdversarialSessionId,
} from "./gates/adversarial.js";
export {
  applyEligiblePatches,
  isEligibleFinding,
} from "./gates/auto-patch.js";
export { resolveSubagent } from "./subagents/resolve.js";
export { buildPacket } from "./subagents/packet.js";
