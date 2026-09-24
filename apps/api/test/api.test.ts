import { describe, expect, test } from "bun:test";
import { apiErrorSchema } from "@waffle/shared";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { parseApiEnv } from "../src/config.ts";
import { validateJson } from "../src/validation.ts";

const validUrl = "postgresql://waffle_api_login:secret@localhost/waffle?sslmode=require";

function request(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

describe("API environment", () => {
  test("accepts an encrypted PostgreSQL URL and defaults", () => {
    expect(parseApiEnv({ DATABASE_URL: validUrl })).toEqual({
      DATABASE_URL: validUrl,
      API_HOST: "127.0.0.1",
      API_PORT: 3000,
    });
  });

  test("rejects missing or unsafe configuration without revealing credentials", () => {
    for (const databaseUrl of [undefined, "postgresql://owner:secret@localhost/waffle", "http://owner:secret@localhost/waffle?sslmode=require"]) {
      expect(() => parseApiEnv({ DATABASE_URL: databaseUrl })).toThrow("DATABASE_URL");
    }
    expect(() => parseApiEnv({ DATABASE_URL: validUrl, API_PORT: "0" })).toThrow("API_PORT");
    expect(() => parseApiEnv({ DATABASE_URL: validUrl, API_PORT: "65536" })).toThrow("API_PORT");
    try {
      parseApiEnv({ DATABASE_URL: "postgresql://owner:secret@localhost/waffle" });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("API responses", () => {
  test("health confirms database connectivity", async () => {
    let pings = 0;
    const app = createApp({ async ping() { pings++; } });
    const response = await app.request(request("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(pings).toBe(1);
  });

  test("database failures have a safe standard response", async () => {
    const app = createApp({ async ping() { throw new Error("database password secret"); } });
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
    const valid = await app.request(request("/test-only", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"count":2}',
    }));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ count: 2 });

    for (const [headers, body, status] of [
      [{ "content-type": "application/json" }, '{"count":0}', 400],
      [{ "content-type": "application/json" }, '{"count":2,"extra":true}', 400],
      [{ "content-type": "text/plain" }, '{"count":2}', 415],
      [{ "content-type": "application/json" }, '{', 400],
    ] as const) {
      const response = await app.request(request("/test-only", { method: "POST", headers, body }));
      expect(response.status).toBe(status);
      expect(apiErrorSchema.safeParse(await response.json()).success).toBe(true);
    }
  });

  test("unexpected handler failures do not expose details", async () => {
    const app = createApp({ async ping() {} });
    app.get("/test-only-error", () => { throw new Error("private internal detail"); });
    const response = await app.request(request("/test-only-error"));
    expect(response.status).toBe(500);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("private internal detail");
  });
});
