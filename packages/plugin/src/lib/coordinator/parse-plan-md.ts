import type { PlaybookEntry } from "@coredevkit/platform";
import { PluginError } from "../errors.js";
import type { StackItem } from "../plan/intent.js";
import type { CoordinatorStep } from "./types.js";

export type PlaybookKeySource = Pick<PlaybookEntry, "key" | "command" | "argv">;

export type ParsedPlanMd = {
  steps: CoordinatorStep[];
  stackItems: StackItem[];
};

function commandKeyFor(command: string, entries: PlaybookKeySource[]): string {
  const compact = command.trim();
  for (const e of entries) {
    if (e.command === compact || e.argv.join(" ") === compact) {
      return e.key;
    }
  }
  return compact;
}

function splitSections(md: string): { title: string; body: string }[] {
  const lines = md.split(/\r?\n/);
  const sections: { title: string; body: string }[] = [{ title: "", body: "" }];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m && m[1] !== undefined) {
      sections.push({ title: m[1].trim(), body: "" });
      continue;
    }
    const cur = sections[sections.length - 1];
    if (!cur) {
      continue;
    }
    cur.body = cur.body ? `${cur.body}\n${line}` : line;
  }
  return sections;
}

function sectionBody(
  sections: { title: string; body: string }[],
  name: string,
): string | undefined {
  const hit = sections.find(
    (s) => s.title.toLowerCase() === name.toLowerCase(),
  );
  return hit?.body;
}

function parseHead(rest: string): { id?: string; title: string; tail: string } {
  const trimmed = rest.trim();
  const bold = trimmed.match(/^\*\*(.+?)\*\*(.*)$/);
  const inner = bold?.[1] ?? trimmed;
  const tail = (bold ? (bold[2] ?? "") : "").trim();
  const idm = inner.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/);
  if (idm && idm[1] && idm[2]) {
    return { id: idm[1], title: idm[2].trim(), tail };
  }
  if (bold) {
    return { title: inner.trim(), tail };
  }
  return { title: trimmed, tail: "" };
}

function extractEvidence(text: string): string | undefined {
  const line = text.match(/Evidence:\s*`([^`]+)`/i);
  if (line && line[1]) {
    return line[1].trim();
  }
  const fence = text.match(/```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/i);
  const first = fence?.[1]?.split(/\r?\n/).find((l) => l.trim());
  return first?.trim();
}

function extractStackId(text: string): string | null {
  const m = text.match(/Stack:\s*`?([A-Za-z][A-Za-z0-9_-]*)`?/i);
  return m?.[1] ?? null;
}

function extractPaths(text: string): string[] {
  const withoutEvidence = text.replace(/Evidence:\s*`[^`]+`/gi, "");
  const withoutStack = withoutEvidence.replace(/Stack:\s*`?[^`\s]+`?/gi, "");
  const paths: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutStack)) !== null) {
    const v = m[1]?.trim();
    if (v) {
      paths.push(v);
    }
  }
  return paths;
}

function parseNumberedBlocks(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let cur: string[] = [];
  const start = /^(\d+)\.\s+(.*)$/;
  for (const line of lines) {
    if (start.test(line)) {
      if (cur.length > 0) {
        blocks.push(cur.join("\n"));
      }
      cur = [line];
      continue;
    }
    if (cur.length > 0) {
      cur.push(line);
    }
  }
  if (cur.length > 0) {
    blocks.push(cur.join("\n"));
  }
  return blocks;
}

function parseSteps(
  body: string,
  entries: PlaybookKeySource[],
): CoordinatorStep[] {
  const blocks = parseNumberedBlocks(body);
  const steps: CoordinatorStep[] = [];
  const seen = new Set<string>();
  let i = 0;
  for (const block of blocks) {
    i += 1;
    const first = block.split(/\r?\n/)[0] ?? "";
    const m = first.match(/^\d+\.\s+(.*)$/);
    if (!m || m[1] === undefined) {
      continue;
    }
    const restOfFirst = m[1];
    const rest = [restOfFirst, ...block.split(/\r?\n/).slice(1)].join("\n");
    const head = parseHead(restOfFirst);
    const id = head.id ?? `S${i}`;
    if (seen.has(id)) {
      throw new PluginError("usage", `plan.md step id ${id} is not unique`);
    }
    seen.add(id);
    const evidence = extractEvidence(rest);
    const step: CoordinatorStep = {
      id,
      step_title: head.title,
      title: head.title,
      status: "pending",
      allowed_paths: extractPaths(rest),
      evidence: null,
      summaries: [],
      blocked_reason: null,
      stack_id: extractStackId(rest),
    };
    if (evidence) {
      step.command_key = commandKeyFor(evidence, entries);
    }
    steps.push(step);
  }
  return steps;
}

function tokenList(text: string, label: string): string[] {
  const m = text.match(new RegExp(`${label}[:\\s]+(.+)$`, "i"));
  if (!m || !m[1]) {
    return [];
  }
  return m[1]
    .split(/[,\s]+/)
    .map((s) => s.replace(/`/g, "").trim())
    .filter(Boolean);
}

function parseStackItems(body: string): StackItem[] {
  const trimmed = body.trim();
  if (!trimmed || /^none$/i.test(trimmed)) {
    return [];
  }
  const blocks = parseNumberedBlocks(body);
  const items: StackItem[] = [];
  let i = 0;
  for (const block of blocks) {
    i += 1;
    const first = block.split(/\r?\n/)[0] ?? "";
    const m = first.match(/^\d+\.\s+(.*)$/);
    if (!m || m[1] === undefined) {
      continue;
    }
    const head = parseHead(m[1]);
    const id = head.id ?? `stack-${i}`;
    const branch = block.match(/branch\s+`([^`]+)`/i)?.[1]?.trim() ?? id;
    const base = block.match(/base\s+`([^`]+)`/i)?.[1]?.trim() ?? "@default";
    const step_ids = tokenList(block, "steps?");
    const depends_on = tokenList(block, "depends_on");
    items.push({
      id,
      title: head.title,
      branch,
      base,
      step_ids,
      depends_on,
    });
  }
  return items;
}

export function parsePlanMd(
  text: string,
  entries: PlaybookKeySource[] = [],
): ParsedPlanMd {
  const sections = splitSections(text);
  const stepsBody = sectionBody(sections, "Steps") ?? text;
  const steps = parseSteps(stepsBody, entries);
  const stackBody = sectionBody(sections, "Stack") ?? "";
  const stackItems = parseStackItems(stackBody);
  return { steps, stackItems };
}

export function parsePlanMdSteps(
  text: string,
  entries: PlaybookKeySource[] = [],
): CoordinatorStep[] {
  return parsePlanMd(text, entries).steps;
}

export function requirePlanMdSteps(
  text: string,
  entries: PlaybookKeySource[] = [],
): ParsedPlanMd {
  const parsed = parsePlanMd(text, entries);
  if (parsed.steps.length === 0) {
    throw new PluginError("usage", "plan.md has no steps");
  }
  return parsed;
}
