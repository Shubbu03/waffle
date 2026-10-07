import { describe, expect, test } from "bun:test";
import { apiErrorSchema } from "@waffle/shared";
import { DrizzleQueryError } from "drizzle-orm";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { parseApiEnv } from "../src/config.ts";
import { validateJson } from "../src/validation.ts";

const AUTH_URI = "https://waffle.example";
const validUrl = "postgresql://waffle_api_login:secret@localhost/waffle?sslmode=require";

function request(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

describe("API environment", () => {
  test("accepts an encrypted PostgreSQL URL and defaults", () => {
    expect(parseApiEnv({ AUTH_URI, DATABASE_URL: validUrl })).toEqual({
      AUTH_URI,
      DATABASE_URL: validUrl,
      API_HOST: "127.0.0.1",
      API_PORT: 3000,
      RPC_REQUESTS_PER_SECOND: 10,
    });
  });

  test("rejects malformed credential escapes before the Postgres driver can crash", () => {
    for (const key of ["DATABASE_URL", "DELIVERY_DATABASE_URL"] as const) {
      for (const credential of ["secret%oops", "secret%FF", "secret%2"]) {
        for (const databaseUrl of [
          `postgresql://waffle_login:${credential}@localhost/waffle?sslmode=require`,
          `postgresql://${credential}:password@localhost/waffle?sslmode=require`,
        ]) {
          const input = { AUTH_URI, DATABASE_URL: validUrl, [key]: databaseUrl };
          expect(() => parseApiEnv(input)).toThrow(key);
          try {
            parseApiEnv(input);
          } catch (error) {
            expect(String(error)).not.toContain(credential);
          }
        }
      }
    }
    const encoded = "postgresql://waffle_login:secret%25%40%3A%2F@localhost/waffle?sslmode=require";
    expect(parseApiEnv({ AUTH_URI, DATABASE_URL: encoded, DELIVERY_DATABASE_URL: encoded }).DATABASE_URL).toBe(encoded);
  });

  test("rejects missing or unsafe configuration without revealing credentials", () => {
    for (const databaseUrl of [
      undefined,
      "postgresql://owner:secret@localhost/waffle",
      "http://owner:secret@localhost/waffle?sslmode=require",
    ]) {
      expect(() => parseApiEnv({ AUTH_URI, DATABASE_URL: databaseUrl })).toThrow("DATABASE_URL");
    }
    expect(() => parseApiEnv({ AUTH_URI, DATABASE_URL: validUrl, API_PORT: "0" })).toThrow("API_PORT");
    expect(() => parseApiEnv({ AUTH_URI, DATABASE_URL: validUrl, API_PORT: "65536" })).toThrow("API_PORT");
    try {
      parseApiEnv({ AUTH_URI, DATABASE_URL: "postgresql://owner:secret@localhost/waffle" });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("API responses", () => {
  test("database DNS failures return retryable 503 without exposing connection details", async () => {
    const app = createApp({ async ping() {} });
    app.get("/test-database-read", () => {
      throw new DrizzleQueryError(
        "select private_sql",
        [],
        Object.assign(new Error("private database hostname"), { code: "ENOTFOUND" }),
      );
    });
    const response = await app.request(request("/test-database-read"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  test("public wallet and signal reads retry one failed DNS lookup and return real handler results", async () => {
    let walletReads = 0;
    let signalReads = 0;
    const dnsFailure = () =>
      new DrizzleQueryError("select private_sql", [], Object.assign(new Error("private host"), { code: "ENOTFOUND" }));
    const app = createApp({
      async ping() {},
      reads: {
        async wallets() {
          if (++walletReads === 1) throw dnsFailure();
          return { items: [] };
        },
        async signals(input) {
          if (++signalReads === 1) throw dnsFailure();
          return { view: input.view, direction: input.direction, items: [], nextCursor: null, hasMore: false };
        },
        async signal() {
          return null;
        },
      },
    });
    expect((await app.request(request("/wallets"))).status).toBe(200);
    expect((await app.request(request("/signals"))).status).toBe(200);
    expect(walletReads).toBe(2);
    expect(signalReads).toBe(2);
  });

  test("persistent DNS failures stop after two public read attempts; SQL errors are not retried", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "42601"]) {
      let attempts = 0;
      const app = createApp({
        async ping() {},
        reads: {
          async wallets() {
            attempts++;
            throw new DrizzleQueryError("select private_sql", [], Object.assign(new Error("private host"), { code }));
          },
          async signals(input) {
            return { view: input.view, direction: input.direction, items: [], nextCursor: null, hasMore: false };
          },
          async signal() {
            return null;
          },
        },
      });
      const response = await app.request(request("/wallets"));
      expect(response.status).toBe(code === "42601" ? 500 : 503);
      expect(attempts).toBe(code === "42601" ? 1 : 2);
    }
  });

  test("database failures in writes and provider DNS errors are never retried", async () => {
    const app = createApp({ async ping() {} });
    let writes = 0;
    app.post("/test-database-write", () => {
      writes++;
      throw new DrizzleQueryError("private write", [], Object.assign(new Error("private host"), { code: "ENOTFOUND" }));
    });
    app.get("/test-provider", () => {
      throw Object.assign(new Error("provider host"), { code: "ENOTFOUND" });
    });
    expect((await app.request(request("/test-database-write", { method: "POST" }))).status).toBe(503);
    expect(writes).toBe(1);
    expect((await app.request(request("/test-provider"))).status).toBe(500);
  });
  test("health confirms database connectivity", async () => {
    let pings = 0;
    const app = createApp({
      async ping() {
        pings++;
      },
    });
    const response = await app.request(request("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(pings).toBe(1);
  });

  test("database failures have a safe standard response", async () => {
    const app = createApp({
      async ping() {
        throw new Error("database password secret");
      },
    });
    const response = await app.request(request("/health"));
    expect(response.status).toBe(503);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.requestId).toBe(response.headers.get("x-request-id") ?? undefined);
  });

  test("query validation and missing routes return standard errors", async () => {
    const app = createApp({ async ping() {} });
    for (const path of ["/health?unexpected=yes", "/health?a=1&a=2"]) {
      const response = await app.request(request(path));
      expect(response.status).toBe(400);
      const body = apiErrorSchema.parse(await response.json());
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }
    const response = await app.request(request("/missing"));
    expect(response.status).toBe(404);
    expect(apiErrorSchema.safeParse(await response.json()).success).toBe(true);
  });

  test("JSON request validation handles types, media type, and malformed input", async () => {
    const app = createApp({ async ping() {} });
    app.post("/test-only", validateJson(z.strictObject({ count: z.number().int().positive() })), (c) => {
      return c.json(c.req.valid("json"));
    });
    const valid = await app.request(
      request("/test-only", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"count":2}',
      }),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ count: 2 });

    for (const [headers, body, status] of [
      [{ "content-type": "application/json" }, '{"count":0}', 400],
      [{ "content-type": "application/json" }, '{"count":2,"extra":true}', 400],
      [{ "content-type": "text/plain" }, '{"count":2}', 415],
      [{ "content-type": "application/json" }, "{", 400],
    ] as const) {
      const response = await app.request(request("/test-only", { method: "POST", headers, body }));
      expect(response.status).toBe(status);
      expect(apiErrorSchema.safeParse(await response.json()).success).toBe(true);
    }
  });

  test("unexpected handler failures do not expose details", async () => {
    const app = createApp({ async ping() {} });
    app.get("/test-only-error", () => {
      throw new Error("private internal detail");
    });
    const response = await app.request(request("/test-only-error"));
    expect(response.status).toBe(500);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("private internal detail");
  });
});

test("live delivery configuration validates its separate credential and fails closed when disabled", async () => {
  expect(parseApiEnv({ AUTH_URI, DATABASE_URL: validUrl, DELIVERY_DATABASE_URL: validUrl }).DELIVERY_DATABASE_URL).toBe(
    validUrl,
  );
  expect(() =>
    parseApiEnv({
      AUTH_URI,
      DATABASE_URL: validUrl,
      DELIVERY_DATABASE_URL: "postgresql://owner:secret@localhost/waffle",
    }),
  ).toThrow("DELIVERY_DATABASE_URL");
  const app = createApp({ async ping() {} });
  expect((await app.request("/live")).status).toBe(503);
});
