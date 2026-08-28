import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { resolveDevkitHome } from "@coredevkit/platform";

const MAX_LOG_BYTES = 1024 * 1024;
const KEEP = 3;

export type PluginLogEvent =
  | "plugin.plan.start"
  | "plugin.plan.complete"
  | "plugin.implement.resume"
  | "plugin.gate.blocked"
  | "plugin.stack.create"
  | "plugin.adversarial.skipped"
  | "plugin.adversarial.passed"
  | "plugin.adversarial.blocked"
  | "plugin.issue_to_pr.start"
  | "plugin.coordinator.write"
  | "plugin.platform.missing"
  | "config_unknown_key";

export type PluginLogRecord = {
  event: PluginLogEvent;
  repo_id?: string;
  duration_ms?: number;
  result?: string;
  code?: string;
  key?: string;
  issue?: number;
};

function rotate(file: string): void {
  try {
    const st = statSync(file);
    if (st.size < MAX_LOG_BYTES) {
      return;
    }
  } catch {
    return;
  }
  const oldest = `${file}.${KEEP - 1}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      return;
    }
  }
  for (let i = KEEP - 2; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        return;
      }
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    return;
  }
}

export function logPlugin(env: NodeJS.ProcessEnv, rec: PluginLogRecord): void {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    component: "plugin",
    event: rec.event,
    ...(rec.repo_id !== undefined ? { repo_id: rec.repo_id } : {}),
    ...(rec.duration_ms !== undefined ? { duration_ms: rec.duration_ms } : {}),
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.code !== undefined ? { code: rec.code } : {}),
    ...(rec.key !== undefined ? { key: rec.key } : {}),
    ...(rec.issue !== undefined ? { issue: rec.issue } : {}),
  })}\n`;
  if (env.DEVKIT_LOG_STDERR === "1") {
    process.stderr.write(line);
  }
  try {
    const home = resolveDevkitHome(env);
    const logsDir = join(home, "logs");
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(logsDir, 0o700);
    } catch {
      // Windows ignores POSIX mode
    }
    const file = join(logsDir, "plugin.jsonl");
    rotate(file);
    appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows ignores POSIX mode
    }
  } catch {
    // logging must not break the caller
  }
}
