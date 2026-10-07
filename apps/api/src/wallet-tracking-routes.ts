import { type AuthStore, createWalletTrackingStore } from "@waffle/db";
import {
  idSchema,
  trackedWalletsResponseSchema,
  trackWalletRequestSchema,
  trackWalletResponseSchema,
  untrackWalletResponseSchema,
} from "@waffle/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { withOwner } from "./auth.ts";
import { apiError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateParams, validateQuery } from "./validation.ts";
import { isOnCurveAddress } from "./wallet-address.ts";

export function createWalletTrackingRoutes(auth: AuthStore) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({ maxSize: 4096, onError: (c) => apiError(c, 413, "VALIDATION_ERROR", "Request body too large") }),
  );

  /** Wallet IDs the caller personally tracks (drives the untrack UI). */
  app.get("/mine", validateQuery(z.strictObject({})), (c) =>
    withOwner(c, auth, async (tx, session) => {
      const items = await createWalletTrackingStore(tx, session.userId).mine();
      return c.json(trackedWalletsResponseSchema.parse({ items }));
    }),
  );

  /** Paste-to-track: validate on-curve, enforce caps, auto-follow with alerts off. */
  app.post("/", validateQuery(z.strictObject({})), validateJson(trackWalletRequestSchema), (c) =>
    withOwner(c, auth, async (tx, session) => {
      const { address, label } = c.req.valid("json");
      if (!isOnCurveAddress(address)) {
        return apiError(c, 400, "VALIDATION_ERROR", "Enter a valid Solana wallet address");
      }
      const result = await createWalletTrackingStore(tx, session.userId).add(address, label);
      switch (result.status) {
        case "ok":
          return c.json(
            trackWalletResponseSchema.parse({
              wallet: result.wallet,
              created: result.created,
              followed: result.followed,
            }),
            result.created ? 201 : 200,
          );
        case "user-limit":
          return apiError(c, 409, "CONFLICT", "You can track up to 3 wallets");
        case "catalog-limit":
          return apiError(c, 409, "CONFLICT", "Tracking is at capacity right now. Try again later.");
        case "paused-catalog":
          return apiError(c, 409, "CONFLICT", "That catalog wallet is paused");
      }
    }),
  );

  /** Stop tracking: removes the caller's follow and pauses the wallet when no tracker remains. */
  app.delete("/:id", validateQuery(z.strictObject({})), validateParams(z.strictObject({ id: idSchema })), (c) =>
    withOwner(c, auth, async (tx, session) => {
      const result = await createWalletTrackingStore(tx, session.userId).remove(c.req.valid("param").id);
      if (result.status === "not-tracked") {
        return apiError(c, 404, "NOT_FOUND", "You are not tracking that wallet");
      }
      return c.json(untrackWalletResponseSchema.parse({ paused: result.paused }));
    }),
  );

  return app;
}
