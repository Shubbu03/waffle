import type { AuthStore } from "@waffle/db";
import {
  createPaperPositionRequestSchema,
  createPaperQuoteRequestSchema,
  getPaperPositionsQuerySchema,
  idSchema,
} from "@waffle/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { bearerToken, hashSecret } from "./auth.ts";
import { apiError } from "./errors.ts";
import type { JupiterService } from "./jupiter.ts";
import { createPaperPositionService, PaperPositionError } from "./paper-positions.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateParams, validateQuery } from "./validation.ts";

export function createPaperPositionRoutes(
  auth: AuthStore,
  jupiter?: Pick<JupiterService, "getPaperQuote"> & Partial<Pick<JupiterService, "getPaperValuation">>,
  now?: () => number,
) {
  const app = new Hono<AppEnv>();
  const service = createPaperPositionService(auth, jupiter, now);
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
    bodyLimit({ maxSize: 4096, onError: (c) => apiError(c, 413, "VALIDATION_ERROR", "Request body too large") }),
  );
  app.post("/quote", validateQuery(z.strictObject({})), validateJson(createPaperQuoteRequestSchema), async (c) =>
    c.json(await service.quote(hashSecret(bearerToken(c.req.header("Authorization")) ?? ""), c.req.valid("json"))),
  );
  app.post("/", validateQuery(z.strictObject({})), validateJson(createPaperPositionRequestSchema), async (c) =>
    c.json(
      await service.create(hashSecret(bearerToken(c.req.header("Authorization")) ?? ""), c.req.valid("json")),
      201,
    ),
  );
  app.get("/", validateQuery(getPaperPositionsQuerySchema), async (c) =>
    c.json(await service.list(hashSecret(bearerToken(c.req.header("Authorization")) ?? ""), c.req.valid("query"))),
  );
  app.get(
    "/by-quote/:quoteId",
    validateQuery(z.strictObject({})),
    validateParams(z.strictObject({ quoteId: idSchema })),
    async (c) =>
      c.json(
        await service.byQuote(
          hashSecret(bearerToken(c.req.header("Authorization")) ?? ""),
          c.req.valid("param").quoteId,
        ),
      ),
  );
  app.get(
    "/:id/valuation",
    validateQuery(z.strictObject({})),
    validateParams(z.strictObject({ id: idSchema })),
    async (c) =>
      c.json(
        await service.valuation(hashSecret(bearerToken(c.req.header("Authorization")) ?? ""), c.req.valid("param").id),
      ),
  );
  app.get("/:id", validateQuery(z.strictObject({})), validateParams(z.strictObject({ id: idSchema })), async (c) =>
    c.json(await service.get(hashSecret(bearerToken(c.req.header("Authorization")) ?? ""), c.req.valid("param").id)),
  );
  app.onError((error, c) => {
    if (!(error instanceof PaperPositionError)) throw error;
    if (error.status >= 500) c.set("failure", error);
    if (error.status === 401) c.header("WWW-Authenticate", "Bearer");
    return apiError(c, error.status, error.code, error.message);
  });
  return app;
}
