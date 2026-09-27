import type { AuthStore, ReadStore } from "@waffle/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { createAuthRoutes } from "./auth-routes.ts";
import { apiError } from "./errors.ts";
import type { JupiterService } from "./jupiter.ts";
import type { LiveDelivery } from "./live-delivery.ts";
import { mountLiveRoute } from "./live-routes.ts";
import { createPaperPositionRoutes } from "./paper-position-routes.ts";
import type { PushDelivery } from "./push-delivery.ts";
import { createPushTokenRoutes } from "./push-token-routes.ts";
import { createReadRoutes } from "./read-routes.ts";
import { createSubscriptionRoutes } from "./subscription-routes.ts";
import type { AppEnv } from "./types.ts";
import { validateQuery } from "./validation.ts";

export function createApp(
  database: { ping(): Promise<void>; reads?: ReadStore },
  auth?: { store: AuthStore; uri: string },
  paper?: { jupiter?: Pick<JupiterService, "getPaperQuote">; now?: () => number },
  live?: LiveDelivery,
  push?: PushDelivery,
) {
  const app = new Hono<AppEnv>();
  mountLiveRoute(app, live);
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
      const delivery = { ...(live ? { live: live.status } : {}), ...(push ? { push: push.status } : {}) };
      if (live?.status.degraded || push?.status.degraded) return c.json({ status: "degraded", ...delivery }, 503);
      return c.json({ status: "ok", ...delivery });
    } catch {
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Service unavailable");
    }
  });

  if (auth) {
    app.route("/auth", createAuthRoutes(auth.store, auth.uri));
    app.route("/push-tokens", createPushTokenRoutes(auth.store));
    app.route("/wallet-subscriptions", createSubscriptionRoutes(auth.store));
    app.route("/paper-positions", createPaperPositionRoutes(auth.store, paper?.jupiter, paper?.now));
  }

  if (database.reads) app.route("/", createReadRoutes(database.reads, auth?.store));

  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "Route not found"));
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return apiError(c, 400, "VALIDATION_ERROR", "Malformed request body");
    }
    return apiError(c, 500, "INTERNAL_ERROR", "Internal server error");
  });
  return app;
}
