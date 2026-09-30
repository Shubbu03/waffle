import { expect, test } from "bun:test";
import { createLogger } from "@waffle/observability";
import { apiErrorSchema } from "@waffle/shared";
import { createApp } from "../src/app.ts";
import { apiError } from "../src/errors.ts";

function setup(ping: () => Promise<void> = async () => {}) {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({ service: "api", write: (line) => logs.push(JSON.parse(line)) });
  const app = createApp({ ping }, undefined, undefined, undefined, undefined, undefined, logger);
  return { app, logs };
}

test("unexpected API failures log once with response correlation and a route template", async () => {
  const { app, logs } = setup();
  app.get("/failure/:id", () => {
    throw new Error("private database password");
  });
  const response = await app.request("/failure/path-secret?accessToken=query-secret", {
    headers: { authorization: "Bearer bearer-secret", cookie: "cookie-secret" },
  });
  expect(response.status).toBe(500);
  const body = apiErrorSchema.parse(await response.json());
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    event: "api.request.failed",
    level: "error",
    method: "GET",
    route: "/failure/:id",
    status: 500,
    code: "INTERNAL_ERROR",
    requestId: response.headers.get("x-request-id"),
  });
  expect(logs[0]?.requestId).toBe(body.requestId);
  expect(logs[0]?.durationMs).toBeGreaterThanOrEqual(0);
  for (const value of ["password", "path-secret", "query-secret", "bearer-secret", "cookie-secret"])
    expect(JSON.stringify(logs)).not.toContain(value);
});

test("typed service failures log while success and ordinary client errors stay quiet", async () => {
  const { app, logs } = setup();
  app.get("/provider", (c) => apiError(c, 503, "SERVICE_UNAVAILABLE", "Quote service unavailable"));
  for (const path of ["/health", "/missing", "/health?bad=1"]) await app.request(path);
  expect(logs).toEqual([]);
  expect((await app.request("/provider")).status).toBe(503);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ event: "api.request.failed", code: "SERVICE_UNAVAILABLE", route: "/provider" });
});

test("health checks log database outages and recovery once without exposing the failure", async () => {
  let unavailable = true;
  const { app, logs } = setup(async () => {
    if (unavailable) throw new Error("private database URL");
  });
  expect((await app.request("/health")).status).toBe(503);
  expect((await app.request("/health")).status).toBe(503);
  expect(logs).toHaveLength(1);
  unavailable = false;
  expect((await app.request("/health")).status).toBe(200);
  await app.request("/health");
  expect(logs.map((log) => log.event)).toEqual(["dependency.failed", "dependency.recovered"]);
  expect(logs[0]?.component).toBe("api.database");
  expect(JSON.stringify(logs)).not.toContain("private database URL");
});
