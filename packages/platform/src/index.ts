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
