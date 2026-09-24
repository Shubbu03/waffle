import { z } from "zod";
import { eventCursorSchema, idSchema } from "./primitives.ts";
import { paperPositionSchema } from "./position.ts";
import { signalSummarySchema } from "./signal.ts";
import { tradeAttemptSchema } from "./trade.ts";

export const apiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "CURSOR_EXPIRED",
  "STALE_SIGNAL",
  "QUOTE_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "UNSUPPORTED_ROUTE",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1).max(200),
    fieldErrors: z.record(z.string().min(1).max(80), z.array(z.string().min(1).max(200)).max(20)).optional(),
  }),
  requestId: idSchema.optional(),
});

/** `before` pages history; `after` replays missed events on reconnect. */
export const getSignalsQuerySchema = z.strictObject({
  view: z.enum(["all", "following"]).default("all"),
  direction: z.enum(["before", "after"]).default("before"),
  cursor: eventCursorSchema.optional(),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().int().min(1).max(50)).default(50),
  walletId: idSchema.optional(),
});

export const signalPageSchema = z.strictObject({
  view: z.enum(["all", "following"]),
  direction: z.enum(["before", "after"]),
  items: z.array(signalSummarySchema).max(50),
  nextCursor: eventCursorSchema.nullable(),
  hasMore: z.boolean(),
});

export const paperPositionsResponseSchema = z.strictObject({
  items: z.array(paperPositionSchema).max(50),
  nextCursor: idSchema.nullable(),
});

export const tradeAttemptsResponseSchema = z.strictObject({
  items: z.array(tradeAttemptSchema).max(50),
  nextCursor: idSchema.nullable(),
});

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type GetSignalsQuery = z.output<typeof getSignalsQuerySchema>;
export type SignalPage = z.infer<typeof signalPageSchema>;
