import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { apiError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateQuery } from "./validation.ts";

export function createApp(database: { ping(): Promise<void> }) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);
    await next();
  });
  app.use("*", secureHeaders());

  app.get("/health", validateQuery(z.strictObject({})), async (c) => {
    try {
      await database.ping();
      return c.json({ status: "ok" });
    } catch {
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Service unavailable");
    }
  });

  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "Route not found"));
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return apiError(c, 400, "VALIDATION_ERROR", "Malformed request body");
    }
    return apiError(c, 500, "INTERNAL_ERROR", "Internal server error");
  });
  return app;
}
