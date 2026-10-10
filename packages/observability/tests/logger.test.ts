import { describe, expect, test } from "bun:test";
import { createFailureReporter, createLogger } from "../src/index.ts";

function capture(level?: string) {
  const lines: string[] = [];
  const logger = createLogger({ service: "api", level, now: () => 0, write: (line) => lines.push(line) });
  return { logger, lines, records: () => lines.map((line): Record<string, unknown> => JSON.parse(line)) };
}

describe("structured logging", () => {
  test("emits one JSON record with timestamp, level, service and useful identifiers", () => {
    const { logger, lines, records } = capture();
    logger.error("api.request.failed", { requestId: "request-1", route: "/signals/:id", status: 500, durationMs: 4 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split("\n")).toHaveLength(1);
    expect(records()).toEqual([
      {
        time: "1970-01-01T00:00:00.000Z",
        level: "error",
        service: "api",
        event: "api.request.failed",
        requestId: "request-1",
        route: "/signals/:id",
        status: 500,
        durationMs: 4,
      },
    ]);
  });

  test("filters levels and defaults unknown settings to info", () => {
    for (const [level, expected] of [
      [undefined, 3],
      ["info", 3],
      ["warn", 2],
      ["error", 1],
      ["silent", 0],
      ["invalid", 3],
    ] as const) {
      const { logger, lines } = capture(level);
      logger.info("started");
      logger.warn("degraded");
      logger.error("failed");
      expect(lines).toHaveLength(expected);
    }
  });

  test("drops sensitive and unknown fields even when a caller spreads them", () => {
    const { logger, lines, records } = capture();
    const fields = {
      requestId: "request-1",
      authorization: "Bearer session-secret",
      token: "push-secret",
      body: { signedTransaction: "transaction-secret" },
      password: "db-secret",
      headers: { cookie: "cookie-secret" },
      url: "postgresql://user:password@db.test/app",
      message: "provider-secret",
      service: "injected",
    };
    logger.warn("dependency.failed", fields);
    expect(records()[0]).toMatchObject({ service: "api", requestId: "request-1" });
    for (const value of [
      "session-secret",
      "push-secret",
      "transaction-secret",
      "db-secret",
      "cookie-secret",
      "provider-secret",
      "injected",
    ])
      expect(lines[0]).not.toContain(value);
  });

  test("scrubs credentials embedded in an allowed text field", () => {
    const { logger, lines } = capture();
    logger.warn("dependency.failed", {
      reason:
        "postgresql://user:db-password@db.test/app https://rpc.test/?api-key=rpc-key Bearer bearer-token password=plain-secret",
    });
    for (const secret of ["db-password", "rpc-key", "bearer-token", "plain-secret"])
      expect(lines[0]).not.toContain(secret);
    expect(lines[0]).toContain("[REDACTED_URL]");
    logger.warn("dependency.failed", { reason: "-----BEGIN PRIVATE KEY-----\nkey-secret\n-----END PRIVATE KEY-----" });
    expect(lines[1]).not.toContain("key-secret");
  });

  test("keeps error classification and call sites without messages, queries or unsafe codes", () => {
    const { logger, lines, records } = capture();
    const error = Object.assign(new Error("password secret; SELECT * FROM auth"), {
      code: "ECONNRESET",
      query: "query-secret",
    });
    error.stack =
      "Error: password secret\n    at run (/private/secret-folder/api.ts:12:3)\n    at fetch (https://rpc.test/?api-key=secret:1:2)";
    logger.error("dependency.failed", { error });
    expect(records()[0]?.error).toEqual({ type: "Error", code: "ECONNRESET", locations: ["api.ts:12:3"] });
    for (const secret of ["password", "SELECT", "query-secret", "secret-folder", "api-key"])
      expect(lines[0]).not.toContain(secret);
    logger.error("dependency.failed", { error: Object.assign(new Error("private"), { code: "provider-secret" }) });
    expect(lines[1]).not.toContain("provider-secret");
    logger.error("dependency.failed", { error: Object.assign(new Error("table details"), { code: "42P01" }) });
    expect(records()[2]?.error).toMatchObject({ code: "42P01" });
  });

  test("bounds circular error causes and does not serialize non-Error payloads", () => {
    const { logger, lines, records } = capture();
    const error = new Error("cause-secret");
    error.cause = error;
    logger.error("dependency.failed", { error });
    logger.error("dependency.failed", { error: { token: "payload-secret" } });
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("cause-secret");
    expect(lines.join("\n")).not.toContain("payload-secret");
    expect(records()[1]?.error).toEqual({ type: "NonError" });
  });

  test("a broken output sink cannot interrupt application work", () => {
    const logger = createLogger({
      service: "watcher",
      write() {
        throw new Error("closed pipe");
      },
    });
    expect(() => logger.error("watcher.startup.failed", { error: new Error("upstream failure") })).not.toThrow();
  });
});

test("dependency outages and recoveries log only on transitions", () => {
  const { logger, records } = capture();
  const dependency = createFailureReporter(logger, "api.push");
  dependency.recover();
  dependency.fail({ reason: "provider-authentication" });
  dependency.fail({ reason: "provider-authentication" });
  dependency.recover();
  dependency.recover();
  dependency.fail();
  expect(records().map((record) => [record.event, record.component, record.level])).toEqual([
    ["dependency.failed", "api.push", "warn"],
    ["dependency.recovered", "api.push", "info"],
    ["dependency.failed", "api.push", "warn"],
  ]);
});
