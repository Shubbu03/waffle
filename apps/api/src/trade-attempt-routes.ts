import type { AuthStore } from "@waffle/db";
import { createLogger, type Logger } from "@waffle/observability";
import {
  createTradeAttemptRequestSchema,
  executeTradeAttemptRequestSchema,
  getTradeAttemptsQuerySchema,
  idSchema,
  rejectTradeAttemptRequestSchema,
} from "@waffle/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { bearerToken, hashSecret } from "./auth.ts";
import { apiError } from "./errors.ts";
import { TradeAssessmentError, type TradeAssessor } from "./trade-assessment.ts";
import { createTradeAttemptService, TradeAttemptError, type TradeOrderProvider } from "./trade-attempts.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateParams, validateQuery } from "./validation.ts";

export function createTradeAttemptRoutes(
  auth: AuthStore,
  jupiter?: TradeOrderProvider,
  now?: () => number,
  logger: Logger = createLogger({ service: "api" }),
  assessor?: TradeAssessor,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  const app = new Hono<AppEnv>();
  const service = createTradeAttemptService(auth, jupiter, now, assessor, network);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c.req.header("Authorization"));
    if (!token) {
      c.header("WWW-Authenticate", "Bearer");
      return apiError(c, 401, "UNAUTHORIZED", "Valid session required");
    }
    await next();
  });
  app.use(
    "*",
    bodyLimit({ maxSize: 12 * 1024, onError: (c) => apiError(c, 413, "VALIDATION_ERROR", "Request body too large") }),
  );
  const tokenHash = (authorization: string | undefined) => hashSecret(bearerToken(authorization) ?? "");
  app.post("/", validateQuery(z.strictObject({})), validateJson(createTradeAttemptRequestSchema), async (c) =>
    c.json(await service.order(tokenHash(c.req.header("Authorization")), c.req.valid("json")), 201),
  );
  app.get("/", validateQuery(getTradeAttemptsQuerySchema), async (c) =>
    c.json(await service.list(tokenHash(c.req.header("Authorization")), c.req.valid("query"))),
  );
  app.get("/:id", validateQuery(z.strictObject({})), validateParams(z.strictObject({ id: idSchema })), async (c) =>
    c.json(await service.get(tokenHash(c.req.header("Authorization")), c.req.valid("param").id)),
  );
  app.post(
    "/:id/execute",
    validateQuery(z.strictObject({})),
    validateParams(z.strictObject({ id: idSchema })),
    validateJson(executeTradeAttemptRequestSchema),
    async (c) => {
      c.set("attemptId", c.req.valid("param").id);
      const attempt = await service.execute(
        tokenHash(c.req.header("Authorization")),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      if (attempt.status === "failed")
        logger.warn("api.trade.failed", {
          requestId: c.get("requestId"),
          attemptId: attempt.id,
          ...(attempt.executeCode === null ? {} : { code: String(attempt.executeCode) }),
          ...(attempt.signature ? { signature: attempt.signature } : {}),
        });
      return c.json(attempt);
    },
  );
  app.post(
    "/:id/wallet-rejection",
    validateQuery(z.strictObject({})),
    validateParams(z.strictObject({ id: idSchema })),
    validateJson(rejectTradeAttemptRequestSchema),
    async (c) =>
      c.json(
        await service.reject(tokenHash(c.req.header("Authorization")), c.req.valid("param").id, c.req.valid("json")),
      ),
  );
  app.onError((error, c) => {
    if (!(error instanceof TradeAttemptError || error instanceof TradeAssessmentError)) throw error;
    if (error.status >= 500) c.set("failure", error);
    if (error.status === 401) c.header("WWW-Authenticate", "Bearer");
    return apiError(c, error.status, error.code, error.message);
  });
  return app;
}
