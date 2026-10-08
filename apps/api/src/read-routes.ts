import { type AuthStore, CursorExpiredError, createReadStore, type ReadStore } from "@waffle/db";
import { getSignalsQuerySchema, idSchema } from "@waffle/shared";
import { Hono } from "hono";
import { z } from "zod";
import { withOwner } from "./auth.ts";
import { readWithDnsRetry } from "./database-read.ts";
import { apiError, validationError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateQuery } from "./validation.ts";

export function createReadRoutes(
  reads: ReadStore,
  auth?: AuthStore,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  const app = new Hono<AppEnv>();
  app.get("/wallets", validateQuery(z.strictObject({})), async (c) =>
    c.json(await readWithDnsRetry(() => reads.wallets(), c.req.raw.signal)),
  );
  app.get("/signals", validateQuery(getSignalsQuerySchema), async (c) => {
    const input = c.req.valid("query");
    try {
      if (input.view === "all") return c.json(await readWithDnsRetry(() => reads.signals(input), c.req.raw.signal));
      c.header("Cache-Control", "no-store");
      if (!auth) return apiError(c, 401, "UNAUTHORIZED", "Valid session required");
      return await withOwner(c, auth, async (tx, session) =>
        c.json(await createReadStore(tx, network).signals(input, session.userId)),
      );
    } catch (error) {
      if (error instanceof CursorExpiredError) {
        return apiError(
          c,
          409,
          "CURSOR_EXPIRED",
          "Signal history is unavailable for this cursor; reload a recent page",
        );
      }
      throw error;
    }
  });
  app.get("/signals/:id", validateQuery(z.strictObject({})), async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return validationError(c, id.error);
    const signal = await readWithDnsRetry(() => reads.signal(id.data), c.req.raw.signal);
    return signal ? c.json(signal) : apiError(c, 404, "NOT_FOUND", "Signal not found");
  });
  return app;
}
