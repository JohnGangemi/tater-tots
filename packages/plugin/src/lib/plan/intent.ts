import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PluginError } from "../errors.js";
import { validateIntent } from "./validate.js";

export const INTENT_VERSION = 1 as const;
export const INTENT_MAX_BYTES = 512 * 1024;

export type QuestionStatus = "open" | "resolved" | "dropped";
export type ThemeDefault = "system" | "light" | "dark";

export type OpenQuestion = {
  id: string;
  ask: string;
  why_it_matters: string;
  blocks: boolean;
  options: string[];
  status: QuestionStatus;
  answer: string | null;
};

export type Component = {
  id: string;
  name: string;
  path: string;
  role: string;
};

export type ProcessStep = {
  id: string;
  title: string;
  detail: string;
  required: boolean;
};

export type Process = {
  id: string;
  title: string;
  complete: boolean;
  steps: ProcessStep[];
};

export type Sequence = {
  id: string;
  title: string;
  process_id: string | null;
  step_ids: string[];
};

export type StackItem = {
  id: string;
  title: string;
  branch: string;
  base: string;
  step_ids: string[];
  depends_on: string[];
};

export type Risk = {
  id: string;
  claim: string;
  mitigation: string;
  severity: "low" | "medium" | "high";
};

export type PlanIntent = {
  version: 1;
  title: string;
  summary: string;
  goal: string;
  agent_plan: string;
  theme_default: ThemeDefault;
  non_goals: string[];
  constraints: string[];
  assumptions: string[];
  open_questions: OpenQuestion[];
  components: Component[];
  processes: Process[];
  sequences: Sequence[];
  stack: StackItem[];
  risks: Risk[];
};

export type IntentParseOpts = {
  htmlCodeBlocks?: boolean;
};

const questionZ = z.object({
  id: z.string().min(1),
  ask: z.string().min(1),
  why_it_matters: z.string().min(1),
  blocks: z.boolean(),
  options: z.array(z.string()),
  status: z.enum(["open", "resolved", "dropped"]),
  answer: z.string().nullable(),
});

const componentZ = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  role: z.string().min(1),
});

const processStepZ = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string(),
  required: z.boolean(),
});

const processZ = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  complete: z.boolean(),
  steps: z.array(processStepZ),
});

const sequenceZ = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  process_id: z.string().min(1).nullable(),
  step_ids: z.array(z.string().min(1)),
});

const stackItemZ = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  step_ids: z.array(z.string().min(1)),
  depends_on: z.array(z.string().min(1)),
});

const riskZ = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  mitigation: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
});

const intentZ = z.object({
  version: z.literal(INTENT_VERSION),
  title: z.string().min(1),
  summary: z.string().min(1),
  goal: z.string().min(1),
  agent_plan: z.string().min(1),
  theme_default: z.enum(["system", "light", "dark"]).optional(),
  non_goals: z.array(z.string()),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  open_questions: z.array(questionZ),
  components: z.array(componentZ),
  processes: z.array(processZ),
  sequences: z.array(sequenceZ),
  stack: z.array(stackItemZ),
  risks: z.array(riskZ),
});

function firstZodIssue(err: z.ZodError): string {
  const iss = err.issues[0];
  if (!iss) {
    return "invalid intent";
  }
  const path = iss.path.length > 0 ? iss.path.join(".") : "intent";
  return `invalid intent: ${path} ${iss.message}`;
}

export function parseIntent(raw: unknown, opts?: IntentParseOpts): PlanIntent {
  const parsed = intentZ.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError("usage", firstZodIssue(parsed.error));
  }
  const intent: PlanIntent = {
    ...parsed.data,
    version: 1,
    theme_default: parsed.data.theme_default ?? "system",
  };
  validateIntent(intent, opts);
  return intent;
}

export function parseIntentJson(
  text: string,
  opts?: IntentParseOpts,
): PlanIntent {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new PluginError("usage", "intent JSON is invalid");
  }
  return parseIntent(raw, opts);
}

export function loadIntentFile(
  file: string,
  opts?: IntentParseOpts,
): PlanIntent {
  if (!existsSync(file)) {
    throw new PluginError("not_found", `intent file not found: ${file}`);
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new PluginError("io", "Could not read intent file", String(err));
  }
  if (Buffer.byteLength(text, "utf8") > INTENT_MAX_BYTES) {
    throw new PluginError("usage", "intent file exceeds 512 KiB");
  }
  return parseIntentJson(text, opts);
}

export function finalizeResolvedQuestions(intent: PlanIntent): PlanIntent {
  const assumptions = intent.assumptions.slice();
  for (const q of intent.open_questions) {
    if (q.status !== "resolved") {
      continue;
    }
    const answer = q.answer?.trim() ?? "";
    if (!answer) {
      continue;
    }
    const line = `Resolved Q-${q.id}: ${answer}`;
    if (!assumptions.includes(line)) {
      assumptions.push(line);
    }
  }
  intent.assumptions = assumptions;
  return intent;
}

export function needsPlanDesigner(intent: PlanIntent): boolean {
  if (intent.components.length > 1) {
    return true;
  }
  return intent.processes.some(
    (p) => p.steps.filter((s) => s.required).length >= 2,
  );
}
