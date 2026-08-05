import { ingestionEnv } from "../config/env.ts";

type Level = "debug" | "info" | "warn" | "error";

const levelRank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levelRank[(ingestionEnv.logLevel as Level) in levelRank
  ? (ingestionEnv.logLevel as Level)
  : "info"];

/** Keys that must never reach the log stream (§16). */
const redactedKeys = new Set([
  "authorization",
  "apikey",
  "api_key",
  "password",
  "secret",
  "token",
  "s3_key_id",
  "s3_application_key",
]);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactedKeys.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>) {
  if (levelRank[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    worker: ingestionEnv.workerId,
    message,
    ...(fields ? redact(fields) : {}),
  });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  child(scope: string): Logger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function makeLogger(scope: string): Logger {
  return {
    child: (child) => makeLogger(`${scope}.${child}`),
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
  };
}

export const logger = makeLogger("ingestion");

/** Normalizes thrown values for structured logs and dead-letter records. */
export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}
