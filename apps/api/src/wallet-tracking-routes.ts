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
import { bearerToken, withOwner } from "./auth.ts";
import { createAuthLimiter } from "./auth-routes.ts";
import { apiError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateParams, validateQuery } from "./validation.ts";
import type { WalletActivityValidator } from "./wallet-activity.ts";
import { isOnCurveAddress } from "./wallet-address.ts";

export function createWalletTrackingRoutes(
  auth: AuthStore,
  activity?: WalletActivityValidator,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  const app = new Hono<AppEnv>();
  const allow = createAuthLimiter();
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
      const items = await createWalletTrackingStore(tx, session.userId, network).mine();
      return c.json(trackedWalletsResponseSchema.parse({ items }));
    }),
  );

  /** Paste-to-track: validate on-curve + supported activity, enforce caps, auto-follow with alerts off. */
  app.post("/", validateQuery(z.strictObject({})), validateJson(trackWalletRequestSchema), async (c) => {
    if (!bearerToken(c.req.header("authorization"))) {
      c.header("WWW-Authenticate", "Bearer");
      return apiError(c, 401, "UNAUTHORIZED", "Valid session required");
    }
    const { address, label } = c.req.valid("json");
    if (!isOnCurveAddress(address)) {
      return apiError(c, 400, "VALIDATION_ERROR", "Enter a valid Solana wallet address");
    }
    let warning: "very-active" | undefined;
    if (activity) {
      // Rate-limit only when validation spend is possible; the per-user cap still applies below.
      const ip = c.env?.remoteAddress ?? "unknown";
      if (!allow(`track:${ip}`, 10)) {
        c.header("Retry-After", "60");
        return apiError(c, 429, "RATE_LIMITED", "Too many tracking attempts");
      }
      // Validation is advisory infrastructure: an RPC outage must not block tracking.
      const verdict = await activity.validate(address).catch(() => null);
      if (verdict) {
        switch (verdict.status) {
          case "no-history":
            return apiError(c, 422, "NO_HISTORY", "No transaction history found for this wallet");
          case "unsupported-wallet":
            return apiError(
              c,
              422,
              "UNSUPPORTED_WALLET",
              "No recent PumpSwap activity — waffle tracks PumpSwap buys only",
            );
          case "too-active":
            return apiError(
              c,
              422,
              "TOO_ACTIVE",
              `This wallet is too active to track reliably (${verdict.txPerHour} tx/h)`,
            );
          case "ok":
            warning = verdict.warning;
            break;
        }
      }
    }
    return withOwner(c, auth, async (tx, session) => {
      const result = await createWalletTrackingStore(tx, session.userId, network).add(address, label);
      switch (result.status) {
        case "ok":
          return c.json(
            trackWalletResponseSchema.parse({
              wallet: result.wallet,
              created: result.created,
              followed: result.followed,
              ...(warning ? { warning } : {}),
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
    });
  });

  /** Stop tracking: removes the caller's follow and pauses the wallet when no tracker remains. */
  app.delete("/:id", validateQuery(z.strictObject({})), validateParams(z.strictObject({ id: idSchema })), (c) =>
    withOwner(c, auth, async (tx, session) => {
      const result = await createWalletTrackingStore(tx, session.userId, network).remove(c.req.valid("param").id);
      if (result.status === "not-tracked") {
        return apiError(c, 404, "NOT_FOUND", "You are not tracking that wallet");
      }
      return c.json(untrackWalletResponseSchema.parse({ paused: result.paused }));
    }),
  );

  return app;
}
