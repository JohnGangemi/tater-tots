export type Hit = {
  name: string;
  label: string;
  path: string;
  line: number;
  qn: string;
};

export type CbmProjectRow = {
  name: string;
  root_path: string;
  nodes?: number;
  edges?: number;
  indexed_at?: string;
};

export type CbmProjectPage = {
  projects: CbmProjectRow[];
  has_more: boolean;
};

export type CbmIndexBody = {
  status?: string;
  name?: string;
  root_path?: string;
  nodes: number;
  edges: number;
};

const DEFAULT_COLS = ["name", "label", "lines", "in", "out"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstInt(value: unknown): number {
  const n = asFiniteNumber(value);
  if (n !== undefined) {
    return Math.trunc(n);
  }
  if (typeof value === "string") {
    const m = value.match(/(\d+)/);
    if (m && m[1]) {
      return Number(m[1]);
    }
  }
  return 0;
}

function stringCols(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((c) => typeof c === "string")) {
    return undefined;
  }
  return value;
}

function flattenResults(rows: unknown[]): Hit[] {
  const hits: Hit[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) {
      continue;
    }
    const name = asString(row.name) ?? "";
    const label = asString(row.label) ?? "";
    const path = asString(row.file) ?? asString(row.file_path) ?? "";
    const line = firstInt(row.line ?? row.start_line ?? row.lines);
    const qn = asString(row.qn) ?? asString(row.qualified_name) ?? name;
    hits.push({ name, label, path, line, qn });
  }
  return hits;
}

function rowToHit(
  row: unknown,
  group: { prefix?: string; file?: string; columns?: string[] },
  payloadCols?: string[],
): Hit | undefined {
  let rec: Record<string, unknown>;
  if (Array.isArray(row)) {
    const cols = group.columns ?? payloadCols ?? DEFAULT_COLS;
    rec = {};
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      if (col) {
        rec[col] = row[i];
      }
    }
  } else if (isPlainObject(row)) {
    rec = row;
  } else {
    return undefined;
  }
  const name = asString(rec.name) ?? "";
  const label = asString(rec.label) ?? "";
  const path = asString(rec.file) ?? asString(rec.file_path) ?? group.file ?? "";
  const line = firstInt(rec.line ?? rec.lines);
  const prefix = group.prefix ?? "";
  const qn =
    asString(rec.qn) ??
    asString(rec.qualified_name) ??
    (prefix && name ? `${prefix}.${name}` : name);
  return { name, label, path, line, qn };
}

export function flattenGroups(payload: unknown, bucket?: string): Hit[] {
  if (bucket) {
    if (!isPlainObject(payload)) {
      return [];
    }
    const nested = payload[bucket];
    if (nested === undefined) {
      return [];
    }
    return flattenGroups(nested);
  }
  if (Array.isArray(payload)) {
    if (payload.every((item) => isPlainObject(item) && Array.isArray(item.rows))) {
      return flattenGroups({ groups: payload });
    }
    return flattenResults(payload);
  }
  if (!isPlainObject(payload)) {
    return [];
  }
  if (Array.isArray(payload.groups)) {
    const hits: Hit[] = [];
    const payloadCols = stringCols(payload.columns);
    for (const g of payload.groups) {
      if (!isPlainObject(g)) {
        continue;
      }
      const group = {
        prefix: asString(g.prefix),
        file: asString(g.file),
        columns: stringCols(g.columns),
      };
      const rows = Array.isArray(g.rows) ? g.rows : [];
      for (const row of rows) {
        const hit = rowToHit(row, group, payloadCols);
        if (hit) {
          hits.push(hit);
        }
      }
    }
    return hits;
  }
  if (Array.isArray(payload.results)) {
    return flattenResults(payload.results);
  }
  return [];
}

export function parseProjectPage(body: unknown): CbmProjectPage {
  if (!isPlainObject(body)) {
    return { projects: [], has_more: false };
  }
  const raw = Array.isArray(body.projects)
    ? body.projects
    : Array.isArray(body.results)
      ? body.results
      : [];
  const projects: CbmProjectRow[] = [];
  for (const row of raw) {
    if (!isPlainObject(row)) {
      continue;
    }
    const name = asString(row.name);
    const root_path = asString(row.root_path);
    if (!name || !root_path) {
      continue;
    }
    const project: CbmProjectRow = { name, root_path };
    const nodes = asFiniteNumber(row.nodes);
    if (nodes !== undefined) {
      project.nodes = nodes;
    }
    const edges = asFiniteNumber(row.edges);
    if (edges !== undefined) {
      project.edges = edges;
    }
    const indexed_at = asString(row.indexed_at);
    if (indexed_at !== undefined) {
      project.indexed_at = indexed_at;
    }
    projects.push(project);
  }
  return { projects, has_more: body.has_more === true };
}

export function parseIndexBody(body: unknown): CbmIndexBody {
  if (!isPlainObject(body)) {
    return { nodes: 0, edges: 0 };
  }
  const nodes = asFiniteNumber(body.nodes) ?? 0;
  const edges = asFiniteNumber(body.edges) ?? 0;
  const out: CbmIndexBody = { nodes, edges };
  const status = asString(body.status);
  if (status !== undefined) {
    out.status = status;
  }
  const name = asString(body.name);
  if (name !== undefined) {
    out.name = name;
  }
  const root_path = asString(body.root_path);
  if (root_path !== undefined) {
    out.root_path = root_path;
  }
  return out;
}

export function snippetFirstLines(text: string, max = 20): string {
  return text.split("\n").slice(0, max).join("\n");
}

export function parseSnippet(body: unknown): string {
  if (!isPlainObject(body)) {
    return "";
  }
  const text = asString(body.source) ?? asString(body.code) ?? asString(body.text) ?? "";
  return snippetFirstLines(text, 20);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function isIdentifierQuery(query: string): boolean {
  return IDENTIFIER_RE.test(query);
}
