import { type AuthStore, createSubscriptionStore } from "@waffle/db";
import { idSchema, putWalletSubscriptionRequestSchema } from "@waffle/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { withOwner } from "./auth.ts";
import { apiError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateParams, validateQuery } from "./validation.ts";

export function createSubscriptionRoutes(auth: AuthStore, network: import("@waffle/shared").SolanaNetwork = "mainnet") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({ maxSize: 4096, onError: (c) => apiError(c, 413, "VALIDATION_ERROR", "Request body too large") }),
  );
  app.get("/", validateQuery(z.strictObject({})), (c) =>
    withOwner(c, auth, async (tx, session) =>
      c.json(await createSubscriptionStore(tx, session.userId, network).list()),
    ),
  );
  app.put(
    "/:walletId",
    validateQuery(z.strictObject({})),
    validateParams(z.strictObject({ walletId: idSchema })),
    validateJson(putWalletSubscriptionRequestSchema),
    (c) =>
      withOwner(c, auth, async (tx, session) => {
        const result = await createSubscriptionStore(tx, session.userId, network).put(
          c.req.valid("param").walletId,
          c.req.valid("json"),
        );
        switch (result.status) {
          case "ok":
            return c.json(result.subscription);
          case "not-found":
            return apiError(c, 404, "NOT_FOUND", "Catalog wallet not found");
          case "paused":
            return apiError(c, 409, "CONFLICT", "Paused wallets cannot accept new follows or alert opt-ins");
        }
      }),
  );
  app.delete(
    "/:walletId",
    validateQuery(z.strictObject({})),
    validateParams(z.strictObject({ walletId: idSchema })),
    (c) =>
      withOwner(c, auth, async (tx, session) => {
        await createSubscriptionStore(tx, session.userId, network).remove(c.req.valid("param").walletId);
        return c.body(null, 204);
      }),
  );
  return app;
}
