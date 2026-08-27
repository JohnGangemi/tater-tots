import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "@coredevkit/platform";
import { parse as parseYaml } from "yaml";
import { PluginError } from "./errors.js";
import { logPlugin } from "./log.js";

export type SubagentRole =
  | "explorer"
  | "coder"
  | "tester"
  | "reviewer"
  | "adversarial-checker"
  | "plan-designer";

export type PluginConfig = {
  subagents: Record<SubagentRole, string>;
  verification: {
    min_steps_for_adversarial: number;
    adversarial_subagent: string;
  };
  plugin: {
    progress_location: "user-data" | "project";
    plan_dir: string | null;
    html_code_blocks: boolean;
    summary_max_chars: number;
  };
};

export const PLUGIN_SHIPPED_DEFAULTS: PluginConfig = {
  subagents: {
    explorer: "explorer",
    coder: "coder",
    tester: "tester",
    reviewer: "reviewer",
    "adversarial-checker": "adversarial-checker",
    "plan-designer": "plan-designer",
  },
  verification: {
    min_steps_for_adversarial: 4,
    adversarial_subagent: "adversarial-checker",
  },
  plugin: {
    progress_location: "user-data",
    plan_dir: null,
    html_code_blocks: false,
    summary_max_chars: 500,
  },
};

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;
const ROLES = new Set<string>([
  "explorer",
  "coder",
  "tester",
  "reviewer",
  "adversarial-checker",
  "plan-designer",
]);
const PLATFORM_ROOT = new Set(["playbook", "tuning", "platform"]);
const PLATFORM_VERIFICATION = new Set([
  "level",
  "evidence_required",
  "evidence_retries",
  "auto_patch",
]);

export type LoadPluginConfigOpts = {
  configFile?: string;
  planDir?: string | null;
};

type MergeState = {
  adversarialSubagentSet: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSkillName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SKILL_NAME_MAX ||
    !SKILL_NAME_RE.test(value)
  ) {
    throw new PluginError("config", `Invalid ${label} ${String(value)}`);
  }
  return value;
}

function readYamlFile(file: string, required: boolean): unknown {
  if (!existsSync(file)) {
    if (required) {
      throw new PluginError("config", `Config file not found: ${file}`);
    }
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new PluginError(
      "config",
      `Could not read config file ${file}`,
      String(err),
    );
  }
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return parseYaml(text);
  } catch (err) {
    throw new PluginError(
      "config",
      `Could not parse YAML ${file}`,
      String(err),
    );
  }
}

function mergeSubagents(
  target: PluginConfig["subagents"],
  raw: unknown,
  env: NodeJS.ProcessEnv,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!ROLES.has(k)) {
      logPlugin(env, { event: "config_unknown_key", key: `subagents.${k}` });
      continue;
    }
    target[k as SubagentRole] = parseSkillName(v, `subagents.${k}`);
  }
}

function mergeVerification(
  target: PluginConfig["verification"],
  raw: unknown,
  env: NodeJS.ProcessEnv,
  state: MergeState,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "min_steps_for_adversarial") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        throw new PluginError(
          "config",
          `Invalid verification.min_steps_for_adversarial ${String(v)}`,
        );
      }
      target.min_steps_for_adversarial = v;
      continue;
    }
    if (k === "adversarial_subagent") {
      target.adversarial_subagent = parseSkillName(
        v,
        "verification.adversarial_subagent",
      );
      state.adversarialSubagentSet = true;
      continue;
    }
    if (PLATFORM_VERIFICATION.has(k)) {
      continue;
    }
    logPlugin(env, { event: "config_unknown_key", key: `verification.${k}` });
  }
}

function mergePlugin(
  target: PluginConfig["plugin"],
  raw: unknown,
  env: NodeJS.ProcessEnv,
): void {
  if (!isPlainObject(raw)) {
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "progress_location") {
      if (v !== "user-data" && v !== "project") {
        throw new PluginError(
          "config",
          `Invalid plugin.progress_location ${String(v)}`,
        );
      }
      target.progress_location = v;
      continue;
    }
    if (k === "plan_dir") {
      if (v === null) {
        target.plan_dir = null;
        continue;
      }
      if (typeof v !== "string" || v.trim() === "") {
        throw new PluginError("config", `Invalid plugin.plan_dir ${String(v)}`);
      }
      target.plan_dir = v;
      continue;
    }
    if (k === "html_code_blocks") {
      if (typeof v !== "boolean") {
        throw new PluginError(
          "config",
          `Invalid plugin.html_code_blocks ${String(v)}`,
        );
      }
      target.html_code_blocks = v;
      continue;
    }
    if (k === "summary_max_chars") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
        throw new PluginError(
          "config",
          `Invalid plugin.summary_max_chars ${String(v)}`,
        );
      }
      target.summary_max_chars = v;
      continue;
    }
    logPlugin(env, { event: "config_unknown_key", key: `plugin.${k}` });
  }
}

function mergeLayer(
  cfg: PluginConfig,
  raw: unknown,
  env: NodeJS.ProcessEnv,
  source: string,
  state: MergeState,
): void {
  if (raw === undefined || raw === null) {
    return;
  }
  if (!isPlainObject(raw)) {
    throw new PluginError("config", `Config ${source} must be a map`);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "subagents") {
      mergeSubagents(cfg.subagents, v, env);
      continue;
    }
    if (k === "verification") {
      mergeVerification(cfg.verification, v, env, state);
      continue;
    }
    if (k === "plugin") {
      mergePlugin(cfg.plugin, v, env);
      continue;
    }
    if (PLATFORM_ROOT.has(k)) {
      continue;
    }
    logPlugin(env, { event: "config_unknown_key", key: k });
  }
}

export function loadPluginConfig(
  ctx: PlatformContext,
  opts: LoadPluginConfigOpts = {},
): PluginConfig {
  const env = ctx.env;
  const cfg = structuredClone(PLUGIN_SHIPPED_DEFAULTS);
  const state: MergeState = { adversarialSubagentSet: false };

  mergeLayer(
    cfg,
    readYamlFile(ctx.paths.userConfigFile, false),
    env,
    ctx.paths.userConfigFile,
    state,
  );

  const projectFile = join(ctx.repoPath, ".devkit", "config.yaml");
  mergeLayer(cfg, readYamlFile(projectFile, false), env, projectFile, state);

  if (opts.configFile) {
    mergeLayer(
      cfg,
      readYamlFile(opts.configFile, true),
      env,
      opts.configFile,
      state,
    );
  }

  const envConfig = env.DEVKIT_CONFIG?.trim();
  if (envConfig) {
    mergeLayer(cfg, readYamlFile(envConfig, true), env, envConfig, state);
  }

  const envPlan = env.DEVKIT_PLAN?.trim();
  if (envPlan) {
    cfg.plugin.plan_dir = envPlan;
  }

  if (opts.planDir !== undefined) {
    cfg.plugin.plan_dir = opts.planDir;
  }

  if (state.adversarialSubagentSet) {
    cfg.subagents["adversarial-checker"] =
      cfg.verification.adversarial_subagent;
  } else {
    cfg.verification.adversarial_subagent =
      cfg.subagents["adversarial-checker"];
  }

  return cfg;
}

export function checkerName(cfg: PluginConfig): string {
  return cfg.verification.adversarial_subagent;
}
