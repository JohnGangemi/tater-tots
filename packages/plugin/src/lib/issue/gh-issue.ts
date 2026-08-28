import { PluginError } from "../errors.js";
import { GH_TIMEOUT_MS, runGh, type GhOpts } from "../stack/gh.js";

export const ISSUE_VIEW_FIELDS =
  "number,title,body,labels,url,comments";

export type IssueSnap = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  body: string;
  comments: string[];
};

export function parseIssueRef(raw: string): number {
  const t = raw.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  const m = t.match(/\/issues\/(\d+)/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  throw new PluginError("usage", `Invalid --issue ${raw}`);
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
      continue;
    }
    if (item && typeof item === "object" && "name" in item) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) {
        out.push(name.trim());
      }
    }
  }
  return out;
}

function commentBodies(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
      continue;
    }
    if (item && typeof item === "object" && "body" in item) {
      const body = (item as { body?: unknown }).body;
      if (typeof body === "string" && body.trim()) {
        out.push(body.trim());
      }
    }
  }
  return out;
}

export function parseIssueJson(text: string): IssueSnap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PluginError("io", "gh issue view returned invalid JSON");
  }
  if (!raw || typeof raw !== "object") {
    throw new PluginError("io", "gh issue view returned invalid JSON");
  }
  const obj = raw as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    body?: unknown;
    labels?: unknown;
    comments?: unknown;
  };
  const number = obj.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    throw new PluginError("io", "gh issue view JSON is missing number");
  }
  const title = typeof obj.title === "string" ? obj.title : "";
  const url = typeof obj.url === "string" ? obj.url : "";
  const body = typeof obj.body === "string" ? obj.body : "";
  return {
    number,
    title,
    url,
    labels: labelNames(obj.labels),
    body,
    comments: commentBodies(obj.comments),
  };
}

export function viewIssue(ref: string, opts: GhOpts): IssueSnap {
  const n = parseIssueRef(ref);
  const r = runGh(
    ["issue", "view", String(n), "--json", ISSUE_VIEW_FIELDS],
    { ...opts, timeoutMs: GH_TIMEOUT_MS },
  );
  if (r.enoent) {
    throw new PluginError("usage", "gh is missing");
  }
  if (r.timedOut) {
    throw new PluginError("io", "gh issue view timed out");
  }
  if (r.status !== 0) {
    throw new PluginError(
      "io",
      "gh issue view failed",
      (r.stderr || r.stdout).trim(),
    );
  }
  return parseIssueJson(r.stdout);
}

export function formatSow(issue: IssueSnap): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "none";
  const comments =
    issue.comments.length > 0
      ? issue.comments
          .map((c, i) => `Comment ${i + 1}:\n${c}`)
          .join("\n\n")
      : "(none)";
  const body = issue.body.trim() ? issue.body : "(empty)";
  return `> Statement of work.

- Issue number: ${issue.number}
- Issue title: ${issue.title}
- Issue url: ${issue.url}
- Issue labels: ${labels}

## Body

${body}

## Comments

${comments}
`;
}

export function issueSummary(issue: IssueSnap): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "none";
  return `Issue ${issue.number}: ${issue.title} (labels: ${labels})`;
}
