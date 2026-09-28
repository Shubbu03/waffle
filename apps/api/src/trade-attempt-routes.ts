import type { AuthStore } from "@waffle/db";
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
import type { JupiterService } from "./jupiter.ts";
import { createTradeAttemptService, TradeAttemptError } from "./trade-attempts.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateParams, validateQuery } from "./validation.ts";

export function createTradeAttemptRoutes(
  auth: AuthStore,
  jupiter?: Pick<JupiterService, "getRealOrder" | "execute">,
  now?: () => number,
) {
  const app = new Hono<AppEnv>();
  const service = createTradeAttemptService(auth, jupiter, now);
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
    async (c) =>
      c.json(
        await service.execute(tokenHash(c.req.header("Authorization")), c.req.valid("param").id, c.req.valid("json")),
      ),
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
    if (!(error instanceof TradeAttemptError)) throw error;
    if (error.status === 401) c.header("WWW-Authenticate", "Bearer");
    return apiError(c, error.status, error.code, error.message);
  });
  return app;
}
