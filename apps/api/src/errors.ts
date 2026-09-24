import type { ApiErrorCode } from "@waffle/shared";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "./types.ts";

export function apiError(
  c: Context<AppEnv>,
  status: 400 | 404 | 415 | 500 | 503,
  code: ApiErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
) {
  return c.json({
    error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) },
    requestId: c.get("requestId"),
  }, status);
}

export function validationError(c: Context<AppEnv>, error: z.ZodError) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return apiError(c, 400, "VALIDATION_ERROR", "Request validation failed", fieldErrors);
}
