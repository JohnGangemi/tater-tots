import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PlatformError } from "./errors.js";
import { logPlatform } from "./log.js";
import { resolveConfigHome, type EnvMap } from "./paths.js";

export type VerificationLevel = "off" | "light" | "full";
export type PlaybookFilter = "low" | "medium" | "high";
export type IndexMode = "fast" | "moderate" | "full";

export type Config = {
  playbook: {
    frequency: string;
    filter: PlaybookFilter;
    max_entries: number;
    keep_failures: boolean;
  };
  verification: {
    level: VerificationLevel;
    evidence_required: boolean;
    evidence_retries: number;
    auto_patch: boolean;
  };
  tuning: {
    enabled: boolean;
    min_repeats: number;
    window_runs: number;
    auto_propose: boolean;
    auto_accept: boolean;
  };
  platform: {
    observe_bash: boolean;
    evidence_on_stop: boolean;
    skip_skills: string[];
    stop_blocking: boolean;
    graph: {
      binary: string | null;
      index_mode: IndexMode;
      wait_timeout_sec: number;
    };
    evidence: {
      timeout_ms: number;
      tail_lines: number;
      tail_bytes: number;
    };
  };
  resolved_level: VerificationLevel;
};

export type LoadConfigOpts = {
  repoPath?: string;
  configFile?: string;
  verification?: string;
  env?: EnvMap;
};

const VERIFICATION_LEVELS = new Set<string>(["off", "light", "full"]);
const PLAYBOOK_FILTERS = new Set<string>(["low", "medium", "high"]);
const INDEX_MODES = new Set<string>(["fast", "moderate", "full"]);

export const SHIPPED_DEFAULTS: Config = {
  playbook: {
    frequency: "session",
    filter: "medium",
    max_entries: 500,
    keep_failures: true,
  },
  verification: {
    level: "light",
    evidence_required: true,
    evidence_retries: 1,
    auto_patch: true,
  },
  tuning: {
    enabled: true,
    min_repeats: 2,
    window_runs: 20,
    auto_propose: true,
    auto_accept: false,
  },
  platform: {
    observe_bash: true,
    evidence_on_stop: true,
    skip_skills: [],
    stop_blocking: false,
    graph: {
      binary: null,
      index_mode: "moderate",
      wait_timeout_sec: 600,
    },
    evidence: {
      timeout_ms: 120000,
      tail_lines: 20,
      tail_bytes: 4096,
    },
  },
  resolved_level: "light",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseLevel(value: unknown): VerificationLevel {
  if (typeof value !== "string" || !VERIFICATION_LEVELS.has(value)) {
    throw new PlatformError(
      "config",
      `Invalid verification.level ${String(value)} (use off, light, or full)`,
    );
  }
  return value as VerificationLevel;
}

function logUnknown(env: EnvMap, key: string): void {
  logPlatform(env, { component: "config", event: "config_unknown_key", key });
}

function readYamlFile(file: string, required: boolean): unknown {
  if (!existsSync(file)) {
    if (required) {
      throw new PlatformError("config", `Config file not found: ${file}`);
    }
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new PlatformError("config", `Could not read config file ${file}`, String(err));
  }
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return parseYaml(text);
  } catch (err) {
    throw new PlatformError("config", `Could not parse YAML ${file}`, String(err));
  }
}

function mergePlaybook(
  target: Config["playbook"],
  raw: unknown,
  env: EnvMap,
  prefix: string,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "frequency") {
      // Reserved and ignored in v1; any value is kept and must not fail load.
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        target.frequency = String(v);
      }
      continue;
    }
    if (k === "filter") {
      const s = asString(v);
      if (s && PLAYBOOK_FILTERS.has(s)) {
        target.filter = s as PlaybookFilter;
      }
      continue;
    }
    if (k === "max_entries") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.max_entries = n;
      }
      continue;
    }
    if (k === "keep_failures") {
      const b = asBool(v);
      if (b !== undefined) {
        target.keep_failures = b;
      }
      continue;
    }
    logUnknown(env, `${prefix}.${k}`);
  }
}

function mergeVerification(
  target: Config["verification"],
  raw: unknown,
  env: EnvMap,
  prefix: string,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "level") {
      target.level = parseLevel(v);
      continue;
    }
    if (k === "evidence_required") {
      const b = asBool(v);
      if (b !== undefined) {
        target.evidence_required = b;
      }
      continue;
    }
    if (k === "evidence_retries") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.evidence_retries = n;
      }
      continue;
    }
    if (k === "auto_patch") {
      const b = asBool(v);
      if (b !== undefined) {
        target.auto_patch = b;
      }
      continue;
    }
    logUnknown(env, `${prefix}.${k}`);
  }
}

function mergeTuning(target: Config["tuning"], raw: unknown, env: EnvMap, prefix: string): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "enabled") {
      const b = asBool(v);
      if (b !== undefined) {
        target.enabled = b;
      }
      continue;
    }
    if (k === "min_repeats") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.min_repeats = n;
      }
      continue;
    }
    if (k === "window_runs") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.window_runs = n;
      }
      continue;
    }
    if (k === "auto_propose") {
      const b = asBool(v);
      if (b !== undefined) {
        target.auto_propose = b;
      }
      continue;
    }
    if (k === "auto_accept") {
      const b = asBool(v);
      if (b !== undefined) {
        target.auto_accept = b;
      }
      continue;
    }
    logUnknown(env, `${prefix}.${k}`);
  }
}

function mergeGraph(
  target: Config["platform"]["graph"],
  raw: unknown,
  env: EnvMap,
  prefix: string,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "binary") {
      if (v === null) {
        target.binary = null;
      } else {
        const s = asString(v);
        if (s !== undefined) {
          target.binary = s;
        }
      }
      continue;
    }
    if (k === "index_mode") {
      const s = asString(v);
      if (s && INDEX_MODES.has(s)) {
        target.index_mode = s as IndexMode;
      }
      continue;
    }
    if (k === "wait_timeout_sec") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.wait_timeout_sec = n;
      }
      continue;
    }
    logUnknown(env, `${prefix}.${k}`);
  }
}

function mergeEvidence(
  target: Config["platform"]["evidence"],
  raw: unknown,
  env: EnvMap,
  prefix: string,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "timeout_ms") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.timeout_ms = n;
      }
      continue;
    }
    if (k === "tail_lines") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.tail_lines = n;
      }
      continue;
    }
    if (k === "tail_bytes") {
      const n = asFiniteNumber(v);
      if (n !== undefined) {
        target.tail_bytes = n;
      }
      continue;
    }
    logUnknown(env, `${prefix}.${k}`);
  }
}

function mergePlatform(
  target: Config["platform"],
  raw: unknown,
  env: EnvMap,
  prefix: string,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "observe_bash") {
      const b = asBool(v);
      if (b !== undefined) {
        target.observe_bash = b;
      }
      continue;
    }
    if (k === "evidence_on_stop") {
      const b = asBool(v);
      if (b !== undefined) {
        target.evidence_on_stop = b;
      }
      continue;
    }
    if (k === "skip_skills") {
      if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
        target.skip_skills = v.slice();
      }
      continue;
    }
    if (k === "stop_blocking") {
      const b = asBool(v);
      if (b !== undefined) {
        target.stop_blocking = b;
      }
      continue;
    }
    if (k === "graph") {
      mergeGraph(target.graph, v, env, `${prefix}.graph`);
      continue;
    }
    if (k === "evidence") {
      mergeEvidence(target.evidence, v, env, `${prefix}.evidence`);
      continue;
    }
    logUnknown(env, `${prefix}.${k}`);
  }
}

function mergeLayer(cfg: Config, raw: unknown, env: EnvMap, source: string): void {
  if (raw === undefined || raw === null) {
    return;
  }
  if (!isPlainObject(raw)) {
    throw new PlatformError("config", `Config ${source} must be a map`);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "playbook") {
      mergePlaybook(cfg.playbook, v, env, "playbook");
      continue;
    }
    if (k === "verification") {
      mergeVerification(cfg.verification, v, env, "verification");
      continue;
    }
    if (k === "tuning") {
      mergeTuning(cfg.tuning, v, env, "tuning");
      continue;
    }
    if (k === "platform") {
      mergePlatform(cfg.platform, v, env, "platform");
      continue;
    }
    logUnknown(env, k);
  }
}

export function loadConfig(opts: LoadConfigOpts = {}): Config {
  const env = opts.env ?? process.env;
  const cfg = structuredClone(SHIPPED_DEFAULTS);

  const userFile = join(resolveConfigHome(env), "config.yaml");
  mergeLayer(cfg, readYamlFile(userFile, false), env, userFile);

  if (opts.repoPath) {
    const projectFile = join(opts.repoPath, ".devkit", "config.yaml");
    mergeLayer(cfg, readYamlFile(projectFile, false), env, projectFile);
  }

  if (opts.configFile) {
    mergeLayer(cfg, readYamlFile(opts.configFile, true), env, opts.configFile);
  }

  const envConfig = env.DEVKIT_CONFIG?.trim();
  if (envConfig) {
    mergeLayer(cfg, readYamlFile(envConfig, true), env, envConfig);
  }

  const envBinary = env.DEVKIT_CBM_BINARY?.trim();
  if (envBinary) {
    cfg.platform.graph.binary = envBinary;
  }

  const envLevel = env.DEVKIT_VERIFICATION?.trim();
  if (envLevel) {
    cfg.verification.level = parseLevel(envLevel);
  }

  if (opts.verification !== undefined && opts.verification !== "") {
    cfg.verification.level = parseLevel(opts.verification);
  }

  cfg.resolved_level = cfg.verification.level;
  return cfg;
}
