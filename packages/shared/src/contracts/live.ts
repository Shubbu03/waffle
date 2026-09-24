import { z } from "zod";
import { apiErrorSchema } from "./api.ts";
import { eventCursorSchema, idSchema } from "./primitives.ts";

export const LIVE_PROTOCOL_VERSION = 1;
const viewSchema = z.enum(["all", "following"]);

export const liveClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    v: z.literal(LIVE_PROTOCOL_VERSION),
    type: z.literal("subscribe"),
    view: z.literal("all"),
    cursor: eventCursorSchema.nullable(),
  }),
  z.strictObject({
    v: z.literal(LIVE_PROTOCOL_VERSION),
    type: z.literal("auth"),
    view: z.literal("following"),
    accessToken: z.base64url().length(43),
    cursor: eventCursorSchema.nullable(),
  }),
]);

export const liveServerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    v: z.literal(LIVE_PROTOCOL_VERSION),
    type: z.literal("ready"),
    view: viewSchema,
    latestEventId: eventCursorSchema.nullable(),
  }),
  z.strictObject({
    v: z.literal(LIVE_PROTOCOL_VERSION),
    type: z.literal("signal"),
    view: viewSchema,
    eventId: eventCursorSchema,
    signalId: idSchema,
    walletId: idSchema,
  }),
  z.strictObject({
    v: z.literal(LIVE_PROTOCOL_VERSION),
    type: z.literal("gap"),
    view: viewSchema,
    oldestAvailableEventId: eventCursorSchema,
  }),
  z.strictObject({
    v: z.literal(LIVE_PROTOCOL_VERSION),
    type: z.literal("error"),
    error: apiErrorSchema.shape.error,
  }),
]);

export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;
export type LiveServerEvent = z.infer<typeof liveServerEventSchema>;
