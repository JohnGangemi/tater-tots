import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { PlatformError } from "./errors.js";
import { mkdirUserOnlySync } from "./fs-atomic.js";
import { resolveDataRoot, userDataPaths, type DevkitPaths, type EnvMap } from "./paths.js";
import { resolveRepoId, type RepoIdentity } from "./repo-id.js";

export type PlatformContext = {
  repoPath: string;
  repoId: string;
  identity: RepoIdentity;
  config: Config;
  paths: DevkitPaths;
  env: EnvMap;
};

export type CreateContextOpts = {
  repoPath?: string;
  configFile?: string;
  verification?: string;
  env?: EnvMap;
};

function resolveRepoPath(opts: CreateContextOpts, env: EnvMap): string {
  const fromCli = opts.repoPath?.trim();
  const fromEnv = env.DEVKIT_PATH?.trim();
  const raw = fromCli || fromEnv || process.cwd();
  const abs = resolve(raw);
  try {
    return realpathSync(abs);
  } catch {
    throw new PlatformError("not_found", `Path not found: ${abs}`);
  }
}

export async function createContext(opts: CreateContextOpts = {}): Promise<PlatformContext> {
  const env = opts.env ?? process.env;
  const repoPath = resolveRepoPath(opts, env);
  const config = loadConfig({
    repoPath,
    configFile: opts.configFile,
    verification: opts.verification,
    env,
  });
  const identity = await resolveRepoId(repoPath, { env });
  const paths = userDataPaths(resolveDataRoot(env), identity.repo_id, env);
  mkdirUserOnlySync(paths.devkitHome);
  mkdirUserOnlySync(paths.playbookDir);
  return {
    repoPath,
    repoId: identity.repo_id,
    identity,
    config,
    paths,
    env,
  };
}
