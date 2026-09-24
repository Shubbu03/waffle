import { validator } from "hono/validator";
import type { z } from "zod";
import { apiError, validationError } from "./errors.ts";

export function validateQuery<Schema extends z.ZodType>(schema: Schema) {
  return validator("query", (value, c) => {
    const params = new URL(c.req.url).searchParams;
    const duplicate = [...new Set(params.keys())].find((key) => params.getAll(key).length > 1);
    if (duplicate) {
      return apiError(c, 400, "VALIDATION_ERROR", "Duplicate query parameter", { [duplicate]: ["Must appear once"] });
    }
    const result = schema.safeParse(value);
    return result.success ? result.data : validationError(c, result.error);
  });
}

export function validateJson<Schema extends z.ZodType>(schema: Schema) {
  return validator("json", (value, c) => {
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return apiError(c, 415, "VALIDATION_ERROR", "Content-Type must be application/json");
    }
    const result = schema.safeParse(value);
    return result.success ? result.data : validationError(c, result.error);
  });
}
