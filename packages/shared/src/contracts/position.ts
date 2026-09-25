import { z } from "zod";
import { scorePolicyV1 } from "../scoring/config.ts";
import { idSchema, parseRawAmount, positiveRawAmountSchema, timestampSchema } from "./primitives.ts";
import { paperQuoteSchema } from "./quote.ts";

export const createPaperPositionRequestSchema = z.strictObject({
  signalId: idSchema,
  quoteId: idSchema,
  sizeLamports: positiveRawAmountSchema.refine((value) => {
    const amount = parseRawAmount(value);
    return amount !== null && amount <= scorePolicyV1.sizeLamports.paperMax;
  }, "Paper size exceeds 0.1 SOL"),
});

export const paperPositionSchema = z
  .strictObject({
    id: idSchema,
    signalId: idSchema,
    sizeLamports: positiveRawAmountSchema,
    entryQuote: paperQuoteSchema,
    simulated: z.literal(true),
    status: z.enum(["open", "closed"]),
    createdAt: timestampSchema,
    closedAt: timestampSchema.nullable(),
  })
  .refine(
    (position) =>
      position.signalId === position.entryQuote.signalId &&
      position.sizeLamports === position.entryQuote.inputAmountLamports &&
      (position.status === "closed") === (position.closedAt !== null),
    "Position and entry quote must agree",
  );

export type CreatePaperPositionRequest = z.infer<typeof createPaperPositionRequestSchema>;
export type PaperPosition = z.infer<typeof paperPositionSchema>;
