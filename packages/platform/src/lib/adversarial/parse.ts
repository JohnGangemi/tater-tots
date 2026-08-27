const PATH_PREFIX = /^(src|lib|test)\//;
const FILE_EXT = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const MD_LINK = /!?\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const BACKTICK = /`([^`\n]+)`/g;
const FENCE_CMD = /```(bash|sh)\s*\n([\s\S]*?)```/gi;
const RUN_LINE = /^(?:[-*]\s+)?(?:run|evidence|test):\s*(.+)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const SECTION_NAME = /\b(API|Functions|Types)\b/i;
const CAMEL = /\b[A-Z][a-zA-Z0-9]*[A-Z][A-Za-z0-9]*\b/g;
const SNAKE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g;
const NUMBERED = /^\s*\d+[.)]\s+\S/;

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const s = item.trim();
    if (!s || seen.has(s)) {
      continue;
    }
    seen.add(s);
    out.push(s);
  }
  return out;
}

function stripDotSlash(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function looksLikePlanPath(raw: string): boolean {
  const p = raw.trim();
  if (!p || /\s/.test(p)) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("#")) {
    return false;
  }
  const norm = stripDotSlash(p);
  if (PATH_PREFIX.test(norm)) {
    return true;
  }
  const base = norm.split("/").pop() ?? "";
  return FILE_EXT.test(base);
}

export function extractPlanPaths(text: string): string[] {
  const out: string[] = [];
  MD_LINK.lastIndex = 0;
  for (const m of text.matchAll(MD_LINK)) {
    const href = m[1];
    if (href && looksLikePlanPath(href)) {
      out.push(href.trim());
    }
  }
  BACKTICK.lastIndex = 0;
  for (const m of text.matchAll(BACKTICK)) {
    const inner = m[1];
    if (inner && looksLikePlanPath(inner)) {
      out.push(inner.trim());
    }
  }
  return unique(out);
}

export function extractCommands(text: string): string[] {
  const out: string[] = [];
  FENCE_CMD.lastIndex = 0;
  for (const m of text.matchAll(FENCE_CMD)) {
    const body = m[2] ?? "";
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) {
        continue;
      }
      out.push(t);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(RUN_LINE);
    if (m && m[1]) {
      out.push(m[1].trim());
    }
  }
  return unique(out);
}

function collectSymbols(line: string, out: string[]): void {
  for (const re of [CAMEL, SNAKE]) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      const s = m[0];
      if (s.length >= 4) {
        out.push(s);
      }
    }
  }
}

export function extractSectionSymbols(text: string): string[] {
  const out: string[] = [];
  let depth: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(HEADING);
    if (h && h[1] && h[2] !== undefined) {
      const level = h[1].length;
      const title = h[2].trim();
      if (depth !== null && level <= depth) {
        depth = null;
      }
      if (SECTION_NAME.test(title)) {
        depth = level;
        collectSymbols(title, out);
      }
      continue;
    }
    if (depth !== null) {
      collectSymbols(line, out);
    }
  }
  return unique(out);
}

export function hasNumberedSteps(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (NUMBERED.test(line)) {
      return true;
    }
  }
  return false;
}
