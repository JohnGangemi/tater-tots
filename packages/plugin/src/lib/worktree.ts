import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { hashSource } from "@coredevkit/platform";

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      shell: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export type WorktreeId = {
  worktree_hash: string;
  worktree_sha256: string;
};

/** SHA-256 of realpath(git toplevel), truncated to 16 hex chars like hashSource. */
export function worktreeHash(repoPath: string): WorktreeId {
  const top = runGit(repoPath, ["rev-parse", "--show-toplevel"]);
  let source = repoPath;
  if (top.ok && top.stdout) {
    try {
      source = realpathSync(top.stdout);
    } catch {
      source = top.stdout;
    }
  } else {
    try {
      source = realpathSync(repoPath);
    } catch {
      source = repoPath;
    }
  }
  const hashed = hashSource(source);
  return { worktree_hash: hashed.repo_id, worktree_sha256: hashed.sha256 };
}
