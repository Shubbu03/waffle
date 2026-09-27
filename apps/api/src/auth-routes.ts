import type { AuthStore } from "@waffle/db";
import { authVerifyRequestSchema } from "@waffle/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { bearerToken, createAuthService, hashSecret, withOwner } from "./auth.ts";
import { apiError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateQuery } from "./validation.ts";

/** Bounded process-local limits for the single-process demo deployment. */
export function createAuthLimiter(now: () => number = Date.now) {
  const entries = new Map<string, { count: number; expires: number }>();
  let nextSweep = 0;
  return (key: string, limit: number): boolean => {
    const time = now();
    if (time >= nextSweep) {
      for (const [name, entry] of entries) if (entry.expires <= time) entries.delete(name);
      nextSweep = time + 60_000;
    }
    let entry = entries.get(key);
    if (!entry || entry.expires <= time) {
      if (!entry && entries.size >= 10_000) return false;
      entry = { count: 0, expires: time + 60_000 };
      entries.set(key, entry);
    }
    return ++entry.count <= limit;
  };
}

export function createAuthRoutes(store: AuthStore, uri: string) {
  const app = new Hono<AppEnv>();
  const service = createAuthService(store, uri);
  const allow = createAuthLimiter();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    // Never trust caller-controlled Forwarded/X-Forwarded-For headers.
    const ip = c.env?.remoteAddress ?? "unknown";
    const allowed = allow(`ip:${ip}`, 60) && (!c.req.path.endsWith("/challenge") || allow(`challenge:${ip}`, 10));
    if (!allowed) {
      c.header("Retry-After", "60");
      return apiError(c, 429, "RATE_LIMITED", "Too many authentication requests");
    }
    await next();
  });
  app.use(
    "*",
    bodyLimit({ maxSize: 8192, onError: (c) => apiError(c, 413, "VALIDATION_ERROR", "Request body too large") }),
  );
  app.post("/challenge", validateQuery(z.strictObject({})), async (c) => c.json(await service.challenge()));
  app.post("/verify", validateJson(authVerifyRequestSchema), async (c) => {
    const request = c.req.valid("json");
    if (!allow(`wallet:${request.accountAddress}`, 10)) {
      c.header("Retry-After", "60");
      return apiError(c, 429, "RATE_LIMITED", "Too many authentication requests");
    }
    const result = await service.verify(request);
    return result ? c.json(result) : apiError(c, 401, "UNAUTHORIZED", "Invalid or expired sign-in challenge");
  });
  app.get("/session", (c) => withOwner(c, store, async (_query, session) => c.json({ session })));
  app.post("/logout", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !(await store.logout(hashSecret(token)))) {
      c.header("WWW-Authenticate", "Bearer");
      return apiError(c, 401, "UNAUTHORIZED", "Valid session required");
    }
    return c.body(null, 204);
  });
  return app;
}
