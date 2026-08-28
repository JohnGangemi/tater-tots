import { spawnSync } from "node:child_process";
import { PluginError } from "../errors.js";

export const GH_TIMEOUT_MS = 60_000;
export const GH_SHORT_MS = 10_000;

export type GhOpts = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type GhRun = {
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

export function runGh(args: string[], opts: GhOpts): GhRun {
  const r = spawnSync("gh", args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    shell: false,
    timeout: opts.timeoutMs ?? GH_SHORT_MS,
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

export function ghAvailable(opts: GhOpts): boolean {
  const r = runGh(["--version"], opts);
  return !r.enoent;
}

export function ghDefaultBranch(opts: GhOpts): string | null {
  const r = runGh(["repo", "view", "--json", "defaultBranchRef"], {
    ...opts,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (r.enoent || r.status !== 0) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(r.stdout);
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const ref = (raw as { defaultBranchRef?: { name?: unknown } })
      .defaultBranchRef;
    if (ref && typeof ref.name === "string" && ref.name.trim()) {
      return ref.name.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export type CreatedPr = {
  url: string | null;
  number: number | null;
};

export function parsePrStdout(stdout: string): CreatedPr {
  const text = stdout.trim();
  const urls = text.match(/https?:\/\/[^\s]+/g) ?? [];
  const url = urls[urls.length - 1] ?? null;
  if (!url) {
    return { url: null, number: null };
  }
  const m = url.match(/\/(?:pull|pr)\/(\d+)/i);
  return { url, number: m?.[1] ? Number(m[1]) : null };
}

export function ghCreatePr(
  input: {
    base: string;
    head: string;
    title: string;
    body: string;
  },
  opts: GhOpts,
): { missing: boolean; pr: CreatedPr } {
  const r = runGh(
    [
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
    ],
    { ...opts, timeoutMs: GH_TIMEOUT_MS },
  );
  if (r.enoent) {
    return { missing: true, pr: { url: null, number: null } };
  }
  if (r.timedOut) {
    throw new PluginError("io", "gh pr create timed out");
  }
  if (r.status !== 0) {
    throw new PluginError(
      "io",
      "gh pr create failed",
      (r.stderr || r.stdout).trim(),
    );
  }
  return { missing: false, pr: parsePrStdout(r.stdout) };
}
