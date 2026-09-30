export type LogLevel = "info" | "warn" | "error" | "silent";

/** Deliberately excludes bodies, headers, credentials, provider URLs and signed transactions. */
export type LogFields = {
  component?: string;
  requestId?: string;
  attemptId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  connectionId?: number;
  attempt?: number;
  retryInMs?: number;
  wallet?: string;
  signature?: string;
  port?: number;
  reason?: string;
  error?: unknown;
};
export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};
const priorities: Record<LogLevel, number> = { info: 0, warn: 1, error: 2, silent: 3 };
const fieldNames = [
  "component",
  "requestId",
  "attemptId",
  "method",
  "route",
  "status",
  "durationMs",
  "code",
  "connectionId",
  "attempt",
  "retryInMs",
  "wallet",
  "signature",
  "port",
  "reason",
] as const;

function sanitize(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, "[REDACTED]")
    .replace(/(?:https?|wss?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:api[-_]?key|password|secret|access[-_]?token|private[-_]?key)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .slice(0, 256);
}

type ErrorDetails = {
  type: string;
  code?: string | number;
  status?: number;
  locations?: string[];
  cause?: ErrorDetails;
};

function describeError(error: unknown, depth = 0): ErrorDetails {
  if (!(error instanceof Error)) return { type: "NonError" };
  // Messages and causes can contain SQL, request bodies or arbitrary provider responses.
  // Keep classification and source locations, never serialize the original Error.
  const type = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.constructor.name) ? error.constructor.name : "Error";
  const rawCode = "code" in error ? error.code : undefined;
  const code =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? rawCode
      : typeof rawCode === "string" && /^(?:[A-Z_][A-Z0-9_]{0,63}|[0-9][A-Z0-9]{4})$/.test(rawCode)
        ? rawCode
        : undefined;
  const locations = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .flatMap((frame) => {
      const location = /(?:^|[/\\])([\w.-]+\.(?:[cm]?[jt]s|tsx)):(\d+):(\d+)\)?$/.exec(frame.trim());
      return location ? [`${location[1]}:${location[2]}:${location[3]}`] : [];
    })
    .slice(0, 8);
  const status = "status" in error ? error.status : undefined;
  return {
    type,
    ...(code === undefined ? {} : { code }),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(locations.length ? { locations } : {}),
    ...(error.cause !== undefined && depth < 2 ? { cause: describeError(error.cause, depth + 1) } : {}),
  };
}

/** One JSON record per line. Logging never changes the outcome of application work. */
export function createLogger(options: {
  service: "api" | "watcher";
  level?: string | undefined;
  write?: (line: string, level: Exclude<LogLevel, "silent">) => void;
  now?: () => number;
}): Logger {
  const minimum = Object.hasOwn(priorities, options.level ?? "") ? (options.level as LogLevel) : "info";
  const write = options.write ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  function log(level: Exclude<LogLevel, "silent">, event: string, fields: LogFields = {}) {
    if (priorities[level] < priorities[minimum]) return;
    try {
      const safe: Record<string, unknown> = {};
      // Enforce the allowlist at runtime too: spreads or JS callers cannot bypass it.
      for (const key of fieldNames) {
        const value = fields[key];
        if (typeof value === "string") safe[key] = sanitize(value);
        else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
      }
      if (fields.error !== undefined) safe.error = describeError(fields.error);
      write(
        JSON.stringify({
          time: new Date(now()).toISOString(),
          level,
          service: options.service,
          event: sanitize(event),
          ...safe,
        }),
        level,
      );
    } catch {
      // A broken output sink must not reject a request, lose a signal or stop recovery.
    }
  }
  return {
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

/** Polling dependencies report an outage once, then once when they recover. */
export function createFailureReporter(logger: Logger, component: string) {
  let failed = false;
  return {
    fail(fields?: LogFields) {
      if (failed) return;
      failed = true;
      logger.warn("dependency.failed", { ...fields, component });
    },
    recover(fields?: LogFields) {
      if (!failed) return;
      failed = false;
      logger.info("dependency.recovered", { ...fields, component });
    },
  };
}
