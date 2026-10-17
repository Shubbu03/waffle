import { z } from "zod";
import { paymentMintSchema, paymentSizeAllowed } from "../assets.ts";
import { WRAPPED_SOL_MINT } from "../program-ids.ts";
import {
  idSchema,
  positiveRawAmountSchema,
  rawAmountSchema,
  solanaAddressSchema,
  timestampSchema,
} from "./primitives.ts";
import { paperQuoteSchema } from "./quote.ts";

export const createPaperQuoteRequestSchema = z
  .strictObject({
    signalId: idSchema,
    inputMint: paymentMintSchema.default(WRAPPED_SOL_MINT),
    sizeRaw: positiveRawAmountSchema,
  })
  .refine((value) => paymentSizeAllowed(value.inputMint, value.sizeRaw, "paper"), "Paper size exceeds the asset limit");

export const createPaperPositionRequestSchema = createPaperQuoteRequestSchema.safeExtend({ quoteId: idSchema });

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
  totalDebitRaw: positiveRawAmountSchema,
  networkFeeLamports: rawAmountSchema,
  quoteAgeMs: z.number().int().nonnegative(),
});

export const paperPositionSchema = z
  .strictObject({
    id: idSchema,
    signalId: idSchema,
    sizeRaw: positiveRawAmountSchema,
    entryQuote: paperQuoteSchema,
    simulated: z.literal(true),
    status: z.enum(["open", "closed"]),
    createdAt: timestampSchema,
    closedAt: timestampSchema.nullable(),
  })
  .refine(
    (position) =>
      position.signalId === position.entryQuote.signalId &&
      position.sizeRaw === position.entryQuote.inputAmountRaw &&
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
    outputMint: paymentMintSchema,
    inputAmountRaw: positiveRawAmountSchema,
    outputAmountRaw: positiveRawAmountSchema,
    minOutputAmountRaw: positiveRawAmountSchema,
    feeLamports: rawAmountSchema,
    slippageBps: z.number().int().min(0).max(5000),
    priceImpactPct: z.number().min(-100).max(100),
    fetchedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .refine(
    (value) =>
      BigInt(value.minOutputAmountRaw) <= BigInt(value.outputAmountRaw) &&
      Date.parse(value.expiresAt) > Date.parse(value.fetchedAt),
    "Invalid valuation quote",
  );
export const paperValuationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), positionId: idSchema, quote: paperValuationQuoteSchema }),
  z.strictObject({ status: z.literal("unavailable"), positionId: idSchema, reason: z.string().min(1).max(200) }),
]);
export type PaperValuationQuote = z.infer<typeof paperValuationQuoteSchema>;
export type PaperValuation = z.infer<typeof paperValuationSchema>;
