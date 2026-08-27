import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { PlatformContext } from "../context.js";
import { isPlatformError } from "../errors.js";
import { graphSearch } from "../graph/tools.js";
import { pathExistsInRepo, splitArgv } from "../playbook/normalize.js";
import { playbookList } from "../playbook/store.js";
import type { PurposeTag } from "../playbook/types.js";
import { hasNumberedSteps } from "./parse.js";
import type { Finding } from "./types.js";

export type GraphGate = {
  ready: boolean;
  known: boolean;
};

const PASS_PURPOSES: PurposeTag[] = ["test", "build", "lint"];

function finding(partial: Omit<Finding, "id">): Finding {
  return { id: "", ...partial };
}

async function withGraph<T>(gate: GraphGate, fn: () => Promise<T>): Promise<T | undefined> {
  if (gate.known && !gate.ready) {
    return undefined;
  }
  try {
    const value = await fn();
    gate.known = true;
    gate.ready = true;
    return value;
  } catch (err) {
    if (
      isPlatformError(err) &&
      (err.code === "graph_unavailable" || err.code === "graph_timeout")
    ) {
      gate.known = true;
      gate.ready = false;
      return undefined;
    }
    throw err;
  }
}

function pathExts(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [""];
  }
  const raw = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  const items = raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ["", ...items];
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function commandOnDisk(command: string, repoPath: string, env: NodeJS.ProcessEnv): boolean {
  const argv = splitArgv(command);
  const bin = argv[0];
  if (!bin) {
    return false;
  }
  if (bin.includes("/") || bin.includes("\\") || isAbsolute(bin)) {
    return pathExistsInRepo(repoPath, bin);
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((p) => p.length > 0);
  const hasDot = basename(bin).includes(".");
  const exts = hasDot ? [""] : pathExts(env);
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isExecutableFile(join(dir, bin + ext))) {
        return true;
      }
    }
  }
  return false;
}

async function similarGraphPath(
  ctx: PlatformContext,
  gate: GraphGate,
  missing: string,
): Promise<string | undefined> {
  const base = basename(missing);
  if (!base) {
    return undefined;
  }
  const out = await withGraph(gate, () => graphSearch(ctx, { query: base, path: base }));
  if (!out) {
    return undefined;
  }
  const miss = missing.replace(/\\/g, "/");
  const hit = out.hits.find((h) => {
    const p = h.path.replace(/\\/g, "/");
    return p.length > 0 && p !== miss && !p.endsWith(`/${miss}`) && p !== `./${miss}`;
  });
  return hit?.path;
}

export async function checkPaths(
  ctx: PlatformContext,
  paths: string[],
  gate: GraphGate,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const p of paths) {
    if (pathExistsInRepo(ctx.repoPath, p)) {
      continue;
    }
    const similar = await similarGraphPath(ctx, gate, p);
    if (similar) {
      out.push(
        finding({
          tag: "patch-plan",
          category: "path",
          claim: `Path ${p} is not on disk`,
          evidence_type: "graph",
          evidence: similar,
          plan_target: p,
          patch: similar,
        }),
      );
      continue;
    }
    out.push(
      finding({
        tag: "block",
        category: "path",
        claim: `Path ${p} is not on disk`,
        evidence_type: "filesystem",
        evidence: p,
        plan_target: p,
        patch: null,
      }),
    );
  }
  return out;
}

export async function checkCommands(ctx: PlatformContext, commands: string[]): Promise<Finding[]> {
  if (commands.length === 0) {
    return [];
  }
  const rows = await playbookList(ctx, ctx.config.playbook.max_entries);
  const suggest = rows.find(
    (e) => e.last_status === "pass" && e.purpose_tags.some((t) => PASS_PURPOSES.includes(t)),
  );
  const out: Finding[] = [];
  for (const command of commands) {
    if (commandOnDisk(command, ctx.repoPath, ctx.env)) {
      continue;
    }
    if (suggest) {
      out.push(
        finding({
          tag: "patch-plan",
          category: "command",
          claim: `Command is not on disk: ${command}`,
          evidence_type: "playbook",
          evidence: suggest.command,
          plan_target: command,
          patch: suggest.command,
        }),
      );
      continue;
    }
    out.push(
      finding({
        tag: "block",
        category: "command",
        claim: `Command is not on disk: ${command}`,
        evidence_type: "filesystem",
        evidence: command,
        plan_target: command,
        patch: null,
      }),
    );
  }
  return out;
}

export async function checkSymbols(
  ctx: PlatformContext,
  symbols: string[],
  gate: GraphGate,
): Promise<Finding[]> {
  if (symbols.length === 0) {
    return [];
  }
  const out: Finding[] = [];
  for (const name of symbols) {
    const found = await withGraph(gate, () => graphSearch(ctx, { query: name }));
    if (found === undefined) {
      return [];
    }
    if (found.hits.length > 0) {
      continue;
    }
    out.push(
      finding({
        tag: "note",
        category: "symbol",
        claim: `Symbol ${name} has no graph hit`,
        evidence_type: "graph",
        evidence: "0 hits",
        plan_target: name,
        patch: null,
      }),
    );
  }
  return out;
}

export function checkSections(text: string): Finding[] {
  if (hasNumberedSteps(text)) {
    return [];
  }
  return [
    finding({
      tag: "block",
      category: "section",
      claim: "Plan has no numbered steps",
      evidence_type: "filesystem",
      evidence: "no numbered steps",
      plan_target: "steps",
      patch: null,
    }),
  ];
}
