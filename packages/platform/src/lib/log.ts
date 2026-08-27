import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { resolveDevkitHome, type EnvMap } from "./paths.js";
import { applyUserOnlyFileSync, mkdirUserOnlySync } from "./fs-atomic.js";
import { join } from "node:path";

const MAX_LOG_BYTES = 1024 * 1024;
const KEEP = 3;

export type LogRecord = {
  component: string;
  event: string;
  repo_id?: string;
  duration_ms?: number;
  result?: string;
  code?: string;
  key?: string;
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

export function logPlatform(env: EnvMap, rec: LogRecord): void {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    component: rec.component,
    event: rec.event,
    ...(rec.repo_id !== undefined ? { repo_id: rec.repo_id } : {}),
    ...(rec.duration_ms !== undefined ? { duration_ms: rec.duration_ms } : {}),
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.code !== undefined ? { code: rec.code } : {}),
    ...(rec.key !== undefined ? { key: rec.key } : {}),
  })}\n`;
  if (env.DEVKIT_LOG_STDERR === "1") {
    process.stderr.write(line);
  }
  try {
    const home = resolveDevkitHome(env);
    const logsDir = join(home, "logs");
    mkdirUserOnlySync(logsDir);
    const file = join(logsDir, "platform.jsonl");
    rotate(file);
    appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    applyUserOnlyFileSync(file);
  } catch {
    // logging must not break the caller
  }
}
