import { type AuthStore, createPushTokenStore } from "@waffle/db";
import { idSchema, pushTokenRegistrationSchema, pushTokenResponseSchema } from "@waffle/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { withOwner } from "./auth.ts";
import { apiError } from "./errors.ts";
import type { AppEnv } from "./types.ts";
import { validateJson, validateParams, validateQuery } from "./validation.ts";

export function createPushTokenRoutes(auth: AuthStore) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({ maxSize: 8192, onError: (c) => apiError(c, 413, "VALIDATION_ERROR", "Request body too large") }),
  );
  app.post("/", validateQuery(z.strictObject({})), validateJson(pushTokenRegistrationSchema), (c) =>
    withOwner(c, auth, async (tx, session) => {
      const result = await createPushTokenStore(tx, session.userId).register(c.req.valid("json"));
      if (result.status === "limit")
        return apiError(c, 409, "CONFLICT", "Remove an existing device before registering another");
      if (result.status === "conflict") return apiError(c, 409, "CONFLICT", "Push token cannot be registered");
      return c.json(pushTokenResponseSchema.parse(result.registration));
    }),
  );
  app.delete("/:id", validateQuery(z.strictObject({})), validateParams(z.strictObject({ id: idSchema })), (c) =>
    withOwner(c, auth, async (tx, session) => {
      await createPushTokenStore(tx, session.userId).remove(c.req.valid("param").id);
      return c.body(null, 204);
    }),
  );
  return app;
}
