import { z } from "zod";
import { WRAPPED_SOL_MINT } from "../program-ids.ts";
import { scorePolicyV1 } from "../scoring/config.ts";
import {
  idSchema,
  parseRawAmount,
  positiveRawAmountSchema,
  rawAmountSchema,
  solanaAddressSchema,
  timestampSchema,
} from "./primitives.ts";
import { paperQuoteSchema } from "./quote.ts";

export const createPaperQuoteRequestSchema = z.strictObject({
  signalId: idSchema,
  sizeLamports: positiveRawAmountSchema.refine((value) => {
    const amount = parseRawAmount(value);
    return amount !== null && amount <= scorePolicyV1.sizeLamports.paperMax;
  }, "Paper size exceeds 0.1 SOL"),
});

export const createPaperPositionRequestSchema = createPaperQuoteRequestSchema.extend({ quoteId: idSchema });

export const getPaperPositionsQuerySchema = z.strictObject({
  cursor: idSchema.optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d?$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .default(50),
});

export const paperFillSchema = z.strictObject({
  outputAmountRaw: positiveRawAmountSchema,
  minOutputAmountRaw: positiveRawAmountSchema,
  totalDebitLamports: positiveRawAmountSchema,
  quoteAgeMs: z.number().int().nonnegative(),
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

export type GetPaperPositionsQuery = z.output<typeof getPaperPositionsQuerySchema>;
export type CreatePaperQuoteRequest = z.infer<typeof createPaperQuoteRequestSchema>;

export const paperPositionWithFillSchema = paperPositionSchema.safeExtend({ fill: paperFillSchema });

export type PaperPositionWithFill = z.infer<typeof paperPositionWithFillSchema>;
export const paperPositionLookupSchema = z.strictObject({ position: paperPositionWithFillSchema.nullable() });

/** Indicative quote for selling the exact simulated holding back to SOL. */
export const paperValuationQuoteSchema = z
  .strictObject({
    inputMint: solanaAddressSchema,
    outputMint: z.literal(WRAPPED_SOL_MINT),
    inputAmountRaw: positiveRawAmountSchema,
    outputLamports: positiveRawAmountSchema,
    minOutputLamports: positiveRawAmountSchema,
    feeLamports: rawAmountSchema,
    slippageBps: z.number().int().min(0).max(5000),
    priceImpactPct: z.number().min(-100).max(100),
    fetchedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .refine(
    (value) =>
      BigInt(value.minOutputLamports) <= BigInt(value.outputLamports) &&
      Date.parse(value.expiresAt) > Date.parse(value.fetchedAt),
    "Invalid valuation quote",
  );
export const paperValuationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), positionId: idSchema, quote: paperValuationQuoteSchema }),
  z.strictObject({ status: z.literal("unavailable"), positionId: idSchema, reason: z.string().min(1).max(200) }),
]);
export type PaperValuationQuote = z.infer<typeof paperValuationQuoteSchema>;
export type PaperValuation = z.infer<typeof paperValuationSchema>;
