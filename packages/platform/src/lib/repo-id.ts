import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PlatformError } from "./errors.js";
import {
  applyUserOnlyFileSync,
  mkdirUserOnlySync,
  movePathSync,
  writeFileAtomicSync,
} from "./fs-atomic.js";
import { logPlatform } from "./log.js";
import { resolveDataRoot, userDataPaths, type DevkitPaths, type EnvMap } from "./paths.js";

export type RepoKind = "url" | "common-dir" | "path";

export type RepoIdentity = {
  version: 1;
  kind: RepoKind;
  repo_id: string;
  sha256: string;
  source: string;
  migrated_from: string | null;
  created_at: string;
};

export type IdentityStub = {
  migrated_to: string;
};

export type ResolveRepoIdOpts = {
  env?: EnvMap;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashSource(source: string): { repo_id: string; sha256: string } {
  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
  return { repo_id: sha256.slice(0, 16), sha256 };
}

export function normalizeOriginUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) {
    return null;
  }

  const scp = /^git@([^:]+):(.+)$/;
  const scpMatch = s.match(scp);
  if (scpMatch) {
    const host = scpMatch[1] ?? "";
    const path = scpMatch[2] ?? "";
    s = `https://${host}/${path}`;
  } else {
    const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::[0-9]+)?\/(.+)$/i;
    const sshMatch = s.match(ssh);
    if (sshMatch) {
      const host = sshMatch[1] ?? "";
      const path = sshMatch[2] ?? "";
      s = `https://${host}/${path}`;
    }
  }

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }

  let path = url.pathname;
  for (let i = 0; i < 8; i++) {
    if (path.endsWith("/")) {
      path = path.slice(0, -1);
      continue;
    }
    if (path.toLowerCase().endsWith(".git")) {
      path = path.slice(0, -4);
      continue;
    }
    break;
  }
  if (!path || path === "/") {
    return null;
  }
  url.pathname = path;
  url.search = "";
  url.hash = "";

  let result = `${url.protocol}//${url.host}${url.pathname}`.toLowerCase();
  for (let i = 0; i < 4; i++) {
    if (result.endsWith("/")) {
      result = result.slice(0, -1);
      continue;
    }
    if (result.endsWith(".git")) {
      result = result.slice(0, -4);
      continue;
    }
    break;
  }
  if (!result || result === "https://" || result === "http://") {
    return null;
  }
  return result;
}

function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function isGitWorktree(repoPath: string): boolean {
  return runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

function gitOrigin(repoPath: string): string | undefined {
  const r = runGit(repoPath, ["remote", "get-url", "origin"]);
  if (!r.ok || !r.stdout) {
    return undefined;
  }
  return r.stdout;
}

function gitCommonDir(repoPath: string): string | undefined {
  const r = runGit(repoPath, ["rev-parse", "--git-common-dir"]);
  if (!r.ok || !r.stdout) {
    return undefined;
  }
  const abs = isAbsolute(r.stdout) ? r.stdout : resolve(repoPath, r.stdout);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function isIdentityStub(value: unknown): value is IdentityStub {
  return isPlainObject(value) && typeof value.migrated_to === "string" && value.kind === undefined;
}

export function readIdentity(file: string): RepoIdentity | IdentityStub | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  const raw = readJson(file);
  if (isIdentityStub(raw)) {
    return raw;
  }
  if (
    isPlainObject(raw) &&
    raw.version === 1 &&
    (raw.kind === "url" || raw.kind === "common-dir" || raw.kind === "path") &&
    typeof raw.repo_id === "string" &&
    typeof raw.sha256 === "string" &&
    typeof raw.source === "string" &&
    typeof raw.created_at === "string"
  ) {
    const migrated =
      raw.migrated_from === null || typeof raw.migrated_from === "string"
        ? raw.migrated_from
        : null;
    return {
      version: 1,
      kind: raw.kind,
      repo_id: raw.repo_id,
      sha256: raw.sha256,
      source: raw.source,
      migrated_from: migrated,
      created_at: raw.created_at,
    };
  }
  return undefined;
}

function dirHasEntries(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function urlIdHasData(paths: DevkitPaths): boolean {
  if (existsSync(paths.playbookFile)) {
    return true;
  }
  return dirHasEntries(paths.overridesDir);
}

function legacyTreeExists(paths: DevkitPaths): boolean {
  if (existsSync(paths.playbookFile) || existsSync(paths.playbookBakFile)) {
    return true;
  }
  if (dirHasEntries(paths.overridesDir) || dirHasEntries(paths.graphDir)) {
    return true;
  }
  const ident = readIdentity(paths.identityFile);
  return Boolean(ident && !isIdentityStub(ident));
}

function allocateRepoId(sha256: string, dataRoot: string, env: EnvMap): string {
  const short = sha256.slice(0, 16);
  const ident = readIdentity(userDataPaths(dataRoot, short).identityFile);
  if (!ident || isIdentityStub(ident) || ident.sha256 === sha256) {
    return short;
  }
  logPlatform(env, {
    component: "repo-id",
    event: "repo_id_collision",
    repo_id: short,
    result: "suffix",
  });
  return sha256.slice(0, 20);
}

function writeIdentity(file: string, identity: RepoIdentity): void {
  mkdirUserOnlySync(dirname(file));
  writeFileAtomicSync(file, `${JSON.stringify(identity, null, 2)}\n`);
}

function writeStub(file: string, newId: string): void {
  mkdirUserOnlySync(dirname(file));
  writeFileAtomicSync(file, `${JSON.stringify({ migrated_to: newId })}\n`);
}

function moveIfExists(from: string, to: string, kind: "file" | "dir"): void {
  if (!existsSync(from)) {
    return;
  }
  if (existsSync(to)) {
    if (kind === "dir") {
      moveDirChildren(from, to);
      return;
    }
    return;
  }
  movePathSync(from, to, kind);
}

function moveDirChildren(from: string, to: string): void {
  mkdirUserOnlySync(to);
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const src = join(from, ent.name);
    const dest = join(to, ent.name);
    const kind = ent.isDirectory() ? "dir" : "file";
    if (existsSync(dest)) {
      if (kind === "dir") {
        moveDirChildren(src, dest);
      }
      continue;
    }
    movePathSync(src, dest, kind);
  }
}

function migrateTree(oldId: string, newId: string, dataRoot: string, env: EnvMap): void {
  const oldPaths = userDataPaths(dataRoot, oldId, env);
  const newPaths = userDataPaths(dataRoot, newId, env);
  mkdirUserOnlySync(newPaths.playbookDir);
  moveIfExists(oldPaths.playbookFile, newPaths.playbookFile, "file");
  moveIfExists(oldPaths.playbookBakFile, newPaths.playbookBakFile, "file");
  moveIfExists(oldPaths.overridesDir, newPaths.overridesDir, "dir");
  moveIfExists(oldPaths.graphDir, newPaths.graphDir, "dir");
  if (existsSync(oldPaths.identityFile)) {
    try {
      unlinkSync(oldPaths.identityFile);
    } catch {
      // stub write replaces it
    }
  }
  writeStub(oldPaths.identityFile, newId);
  applyUserOnlyFileSync(oldPaths.identityFile);
}

function persistIdentity(identity: RepoIdentity, dataRoot: string, env: EnvMap): RepoIdentity {
  const paths = userDataPaths(dataRoot, identity.repo_id, env);
  const existing = readIdentity(paths.identityFile);
  if (
    existing &&
    !isIdentityStub(existing) &&
    existing.sha256 === identity.sha256 &&
    existing.kind === identity.kind
  ) {
    if (identity.migrated_from === null || identity.migrated_from === existing.migrated_from) {
      return existing;
    }
    const updated: RepoIdentity = { ...identity, created_at: existing.created_at };
    writeIdentity(paths.identityFile, updated);
    return updated;
  }
  writeIdentity(paths.identityFile, identity);
  return identity;
}

export async function resolveRepoId(
  repoPath: string,
  opts: ResolveRepoIdOpts = {},
): Promise<RepoIdentity> {
  const env = opts.env ?? process.env;
  const dataRoot = resolveDataRoot(env);
  let realRepo: string;
  try {
    realRepo = realpathSync(repoPath);
  } catch {
    throw new PlatformError("not_found", `Path not found: ${repoPath}`);
  }

  if (!isGitWorktree(realRepo)) {
    const source = realRepo;
    const hashed = hashSource(source);
    const repo_id = allocateRepoId(hashed.sha256, dataRoot, env);
    const identity: RepoIdentity = {
      version: 1,
      kind: "path",
      repo_id,
      sha256: hashed.sha256,
      source,
      migrated_from: null,
      created_at: new Date().toISOString(),
    };
    return persistIdentity(identity, dataRoot, env);
  }

  const commonDir = gitCommonDir(realRepo);
  const originRaw = gitOrigin(realRepo);
  const originNorm = originRaw ? normalizeOriginUrl(originRaw) : null;

  if (originNorm) {
    const hashed = hashSource(originNorm);
    const repo_id = allocateRepoId(hashed.sha256, dataRoot, env);
    let migratedFrom: string | null = null;
    if (commonDir) {
      const commonHashed = hashSource(commonDir);
      const oldId = allocateRepoId(commonHashed.sha256, dataRoot, env);
      if (oldId !== repo_id) {
        const oldPaths = userDataPaths(dataRoot, oldId, env);
        const newPaths = userDataPaths(dataRoot, repo_id, env);
        if (legacyTreeExists(oldPaths)) {
          if (urlIdHasData(newPaths)) {
            logPlatform(env, {
              component: "repo-id",
              event: "repo_id_migrate_skipped",
              repo_id,
            });
          } else {
            migrateTree(oldId, repo_id, dataRoot, env);
            migratedFrom = oldId;
          }
        }
      }
    }
    const identity: RepoIdentity = {
      version: 1,
      kind: "url",
      repo_id,
      sha256: hashed.sha256,
      source: originNorm,
      migrated_from: migratedFrom,
      created_at: new Date().toISOString(),
    };
    return persistIdentity(identity, dataRoot, env);
  }

  const source = commonDir ?? realRepo;
  const hashed = hashSource(source);
  const repo_id = allocateRepoId(hashed.sha256, dataRoot, env);
  const identity: RepoIdentity = {
    version: 1,
    kind: commonDir ? "common-dir" : "path",
    repo_id,
    sha256: hashed.sha256,
    source,
    migrated_from: null,
    created_at: new Date().toISOString(),
  };
  return persistIdentity(identity, dataRoot, env);
}
