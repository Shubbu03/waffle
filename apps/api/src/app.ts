import { type AuthStore, databaseConnectionErrorCode, type ReadStore } from "@waffle/db";
import { createFailureReporter, createLogger, type Logger } from "@waffle/observability";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
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
import { createTradeAttemptRoutes } from "./trade-attempt-routes.ts";
import type { AppEnv } from "./types.ts";
import { validateQuery } from "./validation.ts";
import { createWalletTrackingRoutes } from "./wallet-tracking-routes.ts";

export function createApp(
  database: { ping(): Promise<void>; reads?: ReadStore },
  auth?: { store: AuthStore; uri: string },
  paper?: {
    jupiter?: Pick<JupiterService, "getPaperQuote"> & Partial<Pick<JupiterService, "getPaperValuation">>;
    now?: () => number;
  },
  live?: LiveDelivery,
  push?: PushDelivery,
  trade?: { jupiter?: Pick<JupiterService, "getRealOrder" | "execute">; now?: () => number },
  logger: Logger = createLogger({ service: "api" }),
) {
  const app = new Hono<AppEnv>();
  const health = createFailureReporter(logger, "api.database");
  mountLiveRoute(app, live);
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);
    const started = performance.now();
    await next();
    if (c.res.status >= 500 && c.req.path !== "/health") {
      const code = c.get("errorCode");
      const attemptId = c.get("attemptId");
      logger.error("api.request.failed", {
        requestId,
        method: c.req.method,
        route: routePath(c, -1),
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
        ...(code ? { code } : {}),
        ...(attemptId ? { attemptId } : {}),
        error: c.get("failure"),
      });
    }
  });
  app.use("*", secureHeaders());

  app.get("/health", validateQuery(z.strictObject({})), async (c) => {
    try {
      await database.ping();
      health.recover();
      const delivery = { ...(live ? { live: live.status } : {}), ...(push ? { push: push.status } : {}) };
      if (live?.status.degraded || push?.status.degraded) return c.json({ status: "degraded", ...delivery }, 503);
      return c.json({ status: "ok", ...delivery });
    } catch (error) {
      health.fail({ error, requestId: c.get("requestId") });
      c.header("Retry-After", "5");
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Service unavailable");
    }
  });

  if (auth) {
    app.route("/auth", createAuthRoutes(auth.store, auth.uri));
    app.route("/push-tokens", createPushTokenRoutes(auth.store));
    app.route("/wallet-subscriptions", createSubscriptionRoutes(auth.store));
    app.route("/wallets", createWalletTrackingRoutes(auth.store));
    app.route("/paper-positions", createPaperPositionRoutes(auth.store, paper?.jupiter, paper?.now));
    app.route("/trade-attempts", createTradeAttemptRoutes(auth.store, trade?.jupiter, trade?.now, logger));
  }

  if (database.reads) app.route("/", createReadRoutes(database.reads, auth?.store));

  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "Route not found"));
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return apiError(c, 400, "VALIDATION_ERROR", "Malformed request body");
    }
    c.set("failure", error);
    if (databaseConnectionErrorCode(error)) {
      c.header("Retry-After", "5");
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "The database is temporarily unavailable. Try again shortly.");
    }
    return apiError(c, 500, "INTERNAL_ERROR", "Internal server error");
  });
  return app;
}
