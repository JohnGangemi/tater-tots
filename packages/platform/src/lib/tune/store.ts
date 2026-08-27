import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";
import { mkdirUserOnlySync, movePathSync, writeFileAtomicSync } from "../fs-atomic.js";
import { logPlatform } from "../log.js";
import {
  assertOverrideAllowed,
  historyFilePath,
  isValidProposalId,
  isValidSkillName,
  overrideMdPath,
  proposalFilePath,
} from "./jail.js";
import { blockedThenCompleted, readProgressRecords } from "./progress.js";
import {
  appendSignal,
  factComplete,
  groupKey,
  parseSignal,
  pickFact,
  readSignals,
} from "./signals.js";
import {
  DEFAULT_TUNE_SKILL,
  OVERRIDE_MD_MAX_LINES,
  type Proposal,
  type ProposalStatus,
  type Signal,
  type SignalKind,
  type TuneStatusOut,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProposalStatus(value: unknown): value is ProposalStatus {
  return (
    value === "pending" || value === "accepted" || value === "rejected" || value === "reverted"
  );
}

function utcStamp(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function newProposalId(d = new Date()): string {
  return `tp-${utcStamp(d)}-${randomBytes(4).toString("hex")}`;
}

export function capOverrideMd(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= OVERRIDE_MD_MAX_LINES) {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  return `${lines.slice(0, OVERRIDE_MD_MAX_LINES).join("\n")}\n`;
}

function bullet(signal: Signal): string {
  switch (signal.kind) {
    case "evidence_fail_then_success":
      return `Prefer command \`${signal.fact.success_key ?? ""}\` for purpose ${signal.fact.purpose ?? ""} (failed \`${signal.fact.failed_key ?? ""}\` then passed).`;
    case "adversarial_patch_pattern":
      return `Recurring patch-plan in ${signal.fact.category ?? ""} (pattern ${signal.fact.pattern_hash ?? ""}).`;
    case "step_blocked_then_completed": {
      const cmd = signal.fact.command_key;
      if (cmd) {
        return `Step \`${signal.fact.step_title ?? ""}\` blocked then completed (command \`${cmd}\`).`;
      }
      return `Step \`${signal.fact.step_title ?? ""}\` blocked then completed.`;
    }
    case "skill_skipped":
      return `Skill \`${signal.fact.skill ?? ""}\` skipped by the user.`;
    default: {
      const _never: never = signal.kind;
      return _never;
    }
  }
}

export function buildOverrideMd(facts: Signal[]): string {
  const lines = ["# Personal override", ""];
  const seen = new Set<string>();
  for (const sig of facts) {
    const line = `- ${bullet(sig)}`;
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    lines.push(line);
    if (lines.length >= OVERRIDE_MD_MAX_LINES) {
      break;
    }
  }
  return capOverrideMd(lines.join("\n"));
}

function skillFor(signal: Signal): string | undefined {
  if (signal.kind === "skill_skipped") {
    const skill = signal.fact.skill;
    return skill && isValidSkillName(skill) ? skill : undefined;
  }
  const extra = signal.fact.skill;
  if (extra && isValidSkillName(extra)) {
    return extra;
  }
  return DEFAULT_TUNE_SKILL;
}

function parseProposal(value: unknown): Proposal | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = asString(value.id);
  const skill = asString(value.skill);
  const created_at = asString(value.created_at);
  const status = value.status;
  const repeats = asNumber(value.repeats);
  const window_runs = asNumber(value.window_runs);
  const override_md = asString(value.override_md);
  if (
    !id ||
    !skill ||
    !created_at ||
    !isProposalStatus(status) ||
    repeats === undefined ||
    window_runs === undefined ||
    override_md === undefined
  ) {
    return undefined;
  }
  if (!Array.isArray(value.source_facts)) {
    return undefined;
  }
  const source_facts: Signal[] = [];
  for (const raw of value.source_facts) {
    const sig = parseSignal(raw);
    if (sig) {
      source_facts.push(sig);
    }
  }
  return {
    id,
    skill,
    created_at,
    status,
    source_facts,
    repeats,
    window_runs,
    override_md,
  };
}

function loadProposalFile(file: string): Proposal | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseProposal(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function listProposalFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function listProposals(ctx: PlatformContext): Proposal[] {
  const out: Proposal[] = [];
  for (const file of listProposalFiles(ctx.paths.proposalsDir)) {
    const p = loadProposalFile(file);
    if (p) {
      out.push(p);
    }
  }
  return out;
}

function saveProposal(ctx: PlatformContext, proposal: Proposal): void {
  const file = proposalFilePath(ctx, proposal.id);
  assertOverrideAllowed(ctx, file);
  mkdirUserOnlySync(ctx.paths.proposalsDir);
  writeFileAtomicSync(file, `${JSON.stringify(proposal, null, 2)}\n`);
}

/** Drop when source_facts is empty (T-TN-02). */
export function writeProposal(ctx: PlatformContext, proposal: Proposal): string | undefined {
  if (!proposal.source_facts.length) {
    logPlatform(ctx.env, {
      component: "tune",
      event: "proposal_dropped",
      repo_id: ctx.repoId,
      result: "no_source_facts",
    });
    return undefined;
  }
  if (!isValidSkillName(proposal.skill)) {
    logPlatform(ctx.env, {
      component: "tune",
      event: "proposal_dropped",
      repo_id: ctx.repoId,
      result: "invalid_skill",
    });
    return undefined;
  }
  if (!isValidProposalId(proposal.id)) {
    logPlatform(ctx.env, {
      component: "tune",
      event: "proposal_dropped",
      repo_id: ctx.repoId,
      result: "invalid_id",
    });
    return undefined;
  }
  const facts: Signal[] = [];
  for (const raw of proposal.source_facts) {
    const fact = pickFact(raw.kind, raw.fact);
    if (!factComplete(raw.kind, fact)) {
      continue;
    }
    facts.push({ at: raw.at, kind: raw.kind, fact });
  }
  if (facts.length === 0) {
    logPlatform(ctx.env, {
      component: "tune",
      event: "proposal_dropped",
      repo_id: ctx.repoId,
      result: "no_source_facts",
    });
    return undefined;
  }
  const next: Proposal = {
    ...proposal,
    source_facts: facts,
    override_md: capOverrideMd(proposal.override_md || buildOverrideMd(facts)),
  };
  saveProposal(ctx, next);
  return next.id;
}

function groupState(ctx: PlatformContext): {
  pending: Set<string>;
  cutoff: Map<string, string>;
} {
  const pending = new Set<string>();
  const cutoff = new Map<string, string>();
  for (const p of listProposals(ctx)) {
    if (p.source_facts.length === 0) {
      continue;
    }
    const first = p.source_facts[0];
    if (!first) {
      continue;
    }
    const key = groupKey(first);
    if (p.status === "pending") {
      pending.add(key);
    }
    const prev = cutoff.get(key);
    if (prev === undefined || p.created_at > prev) {
      cutoff.set(key, p.created_at);
    }
  }
  return { pending, cutoff };
}

export async function proposeFromSignals(ctx: PlatformContext): Promise<string[]> {
  if (!ctx.config.tuning.enabled || !ctx.config.tuning.auto_propose) {
    return [];
  }
  const windowRuns = Math.max(1, ctx.config.tuning.window_runs);
  const minRepeats = Math.max(1, ctx.config.tuning.min_repeats);
  const signals = readSignals(ctx.paths.signalsFile);
  const existing = groupState(ctx);
  const written: string[] = [];
  const kinds: SignalKind[] = [
    "evidence_fail_then_success",
    "adversarial_patch_pattern",
    "step_blocked_then_completed",
    "skill_skipped",
  ];
  for (const kind of kinds) {
    const ofKind = signals.filter((s) => s.kind === kind);
    const window = ofKind.slice(-windowRuns);
    const groups = new Map<string, Signal[]>();
    for (const sig of window) {
      const key = groupKey(sig);
      const list = groups.get(key);
      if (list) {
        list.push(sig);
      } else {
        groups.set(key, [sig]);
      }
    }
    for (const [key, facts] of groups) {
      if (existing.pending.has(key)) {
        continue;
      }
      const after = existing.cutoff.get(key);
      const counted = after ? facts.filter((s) => s.at > after) : facts;
      if (counted.length < minRepeats) {
        continue;
      }
      const first = counted[0];
      if (!first) {
        continue;
      }
      const skill = skillFor(first);
      if (!skill) {
        continue;
      }
      const id = newProposalId();
      const proposal: Proposal = {
        id,
        skill,
        created_at: new Date().toISOString(),
        status: "pending",
        source_facts: counted,
        repeats: counted.length,
        window_runs: windowRuns,
        override_md: buildOverrideMd(counted),
      };
      const wrote = writeProposal(ctx, proposal);
      if (!wrote) {
        continue;
      }
      existing.pending.add(key);
      existing.cutoff.set(key, proposal.created_at);
      written.push(wrote);
      if (ctx.config.tuning.auto_accept) {
        await tuneAccept(ctx, wrote);
      }
    }
  }
  return written;
}

export async function recordSignal(
  ctx: PlatformContext,
  input: { kind: SignalKind; fact: Record<string, string>; at?: string },
): Promise<void> {
  if (!ctx.config.tuning.enabled) {
    return;
  }
  const fact = pickFact(input.kind, input.fact);
  if (!factComplete(input.kind, fact)) {
    return;
  }
  const signal: Signal = {
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    fact,
  };
  assertOverrideAllowed(ctx, ctx.paths.signalsFile);
  appendSignal(ctx.paths.signalsFile, signal);
  await proposeFromSignals(ctx);
}

export async function ingestProgress(ctx: PlatformContext): Promise<void> {
  if (!ctx.config.tuning.enabled) {
    return;
  }
  const records = readProgressRecords(ctx.paths.progressDir);
  if (records.length === 0) {
    return;
  }
  const hits = blockedThenCompleted(records);
  if (hits.length === 0) {
    return;
  }
  const existing = readSignals(ctx.paths.signalsFile).filter(
    (s) => s.kind === "step_blocked_then_completed",
  );
  const have = new Map<string, number>();
  for (const sig of existing) {
    const key = groupKey(sig);
    have.set(key, (have.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const hit of hits) {
    const fact: Record<string, string> = { step_title: hit.step_title };
    if (hit.command_key) {
      fact.command_key = hit.command_key;
    }
    const dummy: Signal = {
      at: "",
      kind: "step_blocked_then_completed",
      fact,
    };
    const key = groupKey(dummy);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n <= (have.get(key) ?? 0)) {
      continue;
    }
    await recordSignal(ctx, { kind: "step_blocked_then_completed", fact });
  }
}

export async function tuneStatus(ctx: PlatformContext): Promise<TuneStatusOut> {
  const pending = listProposals(ctx)
    .filter((p) => p.status === "pending" && p.source_facts.length > 0)
    .map((p) => p.id)
    .sort();
  return {
    pending,
    auto_accept: ctx.config.tuning.auto_accept,
  };
}

export async function tuneShow(ctx: PlatformContext, id: string): Promise<Proposal> {
  if (!isValidProposalId(id)) {
    throw new PlatformError("usage", "Invalid proposal id");
  }
  const proposal = loadProposalFile(proposalFilePath(ctx, id));
  if (!proposal || proposal.source_facts.length === 0) {
    throw new PlatformError("not_found", `Proposal not found: ${id}`);
  }
  return proposal;
}

function loadPending(ctx: PlatformContext, id: string): Proposal {
  if (!isValidProposalId(id)) {
    throw new PlatformError("usage", "Invalid proposal id");
  }
  const proposal = loadProposalFile(proposalFilePath(ctx, id));
  if (!proposal) {
    throw new PlatformError("not_found", `Proposal not found: ${id}`);
  }
  if (proposal.status !== "pending") {
    throw new PlatformError("usage", `Proposal is ${proposal.status}`);
  }
  if (proposal.source_facts.length === 0) {
    throw new PlatformError("usage", "Proposal has no source_facts");
  }
  return proposal;
}

function archiveOverride(ctx: PlatformContext, skill: string, dest: string): void {
  if (!existsSync(dest)) {
    return;
  }
  const hist = historyFilePath(ctx, skill, Date.now());
  assertOverrideAllowed(ctx, hist);
  mkdirUserOnlySync(ctx.paths.historyDir);
  const prev = readFileSync(dest, "utf8");
  writeFileAtomicSync(hist, prev);
}

function writeOverride(ctx: PlatformContext, skill: string, md: string): void {
  const dest = overrideMdPath(ctx, skill);
  assertOverrideAllowed(ctx, dest);
  archiveOverride(ctx, skill, dest);
  mkdirUserOnlySync(ctx.paths.overridesDir);
  writeFileAtomicSync(dest, capOverrideMd(md));
}

export async function tuneAccept(ctx: PlatformContext, id: string): Promise<void> {
  const proposal = loadPending(ctx, id);
  writeOverride(ctx, proposal.skill, proposal.override_md);
  saveProposal(ctx, { ...proposal, status: "accepted" });
}

export async function tuneReject(ctx: PlatformContext, id: string): Promise<void> {
  const proposal = loadPending(ctx, id);
  saveProposal(ctx, { ...proposal, status: "rejected" });
}

export async function tuneRevert(ctx: PlatformContext, skill: string): Promise<void> {
  const dest = overrideMdPath(ctx, skill);
  if (!existsSync(dest)) {
    throw new PlatformError("not_found", `No override for skill ${skill}`);
  }
  assertOverrideAllowed(ctx, dest);
  const hist = historyFilePath(ctx, skill, Date.now());
  assertOverrideAllowed(ctx, hist);
  mkdirUserOnlySync(ctx.paths.historyDir);
  movePathSync(dest, hist, "file");
  if (existsSync(dest)) {
    try {
      unlinkSync(dest);
    } catch {
      throw new PlatformError("io", `Could not remove override ${dest}`);
    }
  }
  for (const p of listProposals(ctx)) {
    if (p.skill === skill && p.status === "accepted") {
      saveProposal(ctx, { ...p, status: "reverted" });
    }
  }
}

export function patternHash(category: string, tag: string): string {
  return createHash("sha256").update(`${category}|${tag}`, "utf8").digest("hex").slice(0, 16);
}

export { isValidProposalId, isValidSkillName, overrideMdPath } from "./jail.js";
export type { Proposal, Signal, SignalKind, TuneStatusOut } from "./types.js";
