import { type AuthStore, CursorExpiredError, createReadStore, type ReadStore } from "@waffle/db";
import { getSignalsQuerySchema, idSchema } from "@waffle/shared";
import { Hono } from "hono";
import { z } from "zod";
import { withOwner } from "./auth.ts";
import { apiError, validationError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateQuery } from "./validation.ts";

export function createReadRoutes(reads: ReadStore, auth?: AuthStore) {
  const app = new Hono<AppEnv>();
  app.get("/wallets", validateQuery(z.strictObject({})), async (c) => c.json(await reads.wallets()));
  app.get("/signals", validateQuery(getSignalsQuerySchema), async (c) => {
    const input = c.req.valid("query");
    try {
      if (input.view === "all") return c.json(await reads.signals(input));
      c.header("Cache-Control", "no-store");
      if (!auth) return apiError(c, 401, "UNAUTHORIZED", "Valid session required");
      return await withOwner(c, auth, async (tx, session) =>
        c.json(await createReadStore(tx).signals(input, session.userId)),
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
    const signal = await reads.signal(id.data);
    return signal ? c.json(signal) : apiError(c, 404, "NOT_FOUND", "Signal not found");
  });
  return app;
}
