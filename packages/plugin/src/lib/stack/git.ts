import { spawnSync } from "node:child_process";
import { PluginError } from "../errors.js";

export const GIT_LONG_MS = 60_000;
export const GIT_SHORT_MS = 10_000;

export type GitOpts = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type GitRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  enoent: boolean;
  timedOut: boolean;
};

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code?: string }).code ?? "");
  }
  return "";
}

export function runGit(args: string[], opts: GitOpts): GitRun {
  const r = spawnSync("git", args, {
    cwd: opts.cwd,
    env: { ...opts.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    shell: false,
    timeout: opts.timeoutMs ?? GIT_SHORT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const code = errCode(r.error);
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    enoent: code === "ENOENT",
    timedOut: code === "ETIMEDOUT",
  };
}

export function gitOk(args: string[], opts: GitOpts): GitRun {
  const r = runGit(args, opts);
  if (r.enoent) {
    throw new PluginError("io", "git is missing");
  }
  if (r.timedOut) {
    throw new PluginError("io", `git ${args[0] ?? "command"} timed out`);
  }
  if (r.status !== 0) {
    throw new PluginError(
      "io",
      `git ${args[0] ?? "command"} failed`,
      (r.stderr || r.stdout).trim(),
    );
  }
  return r;
}

export function hasOrigin(opts: GitOpts): boolean {
  const r = runGit(["remote", "get-url", "origin"], opts);
  return r.status === 0 && r.stdout.trim().length > 0;
}

export function isDirty(opts: GitOpts): boolean {
  const r = gitOk(["status", "--porcelain"], opts);
  return r.stdout.trim().length > 0;
}

export function gitFetchOrigin(opts: GitOpts): void {
  if (!hasOrigin(opts)) {
    return;
  }
  gitOk(["fetch", "origin"], { ...opts, timeoutMs: GIT_LONG_MS });
}

export function gitRemoteBaseExists(base: string, opts: GitOpts): boolean {
  const r = runGit(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`],
    opts,
  );
  return r.status === 0;
}

export function gitCurrentBranch(opts: GitOpts): string {
  return gitOk(["rev-parse", "--abbrev-ref", "HEAD"], opts).stdout.trim();
}

export function gitCheckoutBranch(
  base: string,
  branch: string,
  opts: GitOpts,
): void {
  const start = gitRemoteBaseExists(base, opts) ? `origin/${base}` : base;
  gitOk(["checkout", start], opts);
  gitOk(["checkout", "-B", branch], opts);
}

export function gitAddPaths(paths: string[], opts: GitOpts): void {
  for (const p of paths) {
    gitOk(["add", "--", p], opts);
  }
}

export function gitCommit(
  title: string,
  identity: { name: string; email: string },
  opts: GitOpts,
): string {
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  gitOk(["commit", "-m", title], { ...opts, env });
  return gitOk(["rev-parse", "HEAD"], { ...opts, env }).stdout.trim();
}

export function gitPushBranch(branch: string, opts: GitOpts): void {
  gitOk(["push", "-u", "origin", branch], {
    ...opts,
    timeoutMs: GIT_LONG_MS,
  });
}

export function gitIdentity(opts: GitOpts): { name: string; email: string } {
  const nameCfg = runGit(["config", "user.name"], opts).stdout.trim();
  const emailCfg = runGit(["config", "user.email"], opts).stdout.trim();
  const name =
    nameCfg || opts.env.GIT_AUTHOR_NAME || opts.env.GIT_COMMITTER_NAME || "";
  const email =
    emailCfg ||
    opts.env.GIT_AUTHOR_EMAIL ||
    opts.env.GIT_COMMITTER_EMAIL ||
    "";
  if (!name.trim() || !email.trim()) {
    throw new PluginError("usage", "set git user.name and user.email");
  }
  return { name: name.trim(), email: email.trim() };
}

export const ORIGIN_HEAD_PREFIX = "refs/remotes/origin/";

export function originHeadName(symbolicRef: string): string | null {
  const t = symbolicRef.trim();
  if (!t) {
    return null;
  }
  if (t.startsWith(ORIGIN_HEAD_PREFIX)) {
    return t.slice(ORIGIN_HEAD_PREFIX.length) || null;
  }
  return t;
}

export function gitOriginHead(opts: GitOpts): string | null {
  const r = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], opts);
  if (r.status !== 0) {
    return null;
  }
  return originHeadName(r.stdout);
}
