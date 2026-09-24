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

const quoteFields = z.strictObject({
  id: idSchema,
  signalId: idSchema,
  inputMint: z.literal(WRAPPED_SOL_MINT),
  outputMint: solanaAddressSchema,
  inputAmountLamports: positiveRawAmountSchema,
  outputAmountRaw: positiveRawAmountSchema,
  minOutputAmountRaw: positiveRawAmountSchema,
  feeLamports: rawAmountSchema,
  slippageBps: z.number().int().min(0).max(5_000),
  priceImpactBps: z.number().int().min(0).max(10_000),
  fetchedAt: timestampSchema,
  expiresAt: timestampSchema,
});

function quoteIsConsistent(quote: z.infer<typeof quoteFields>): boolean {
  const minimum = parseRawAmount(quote.minOutputAmountRaw);
  const output = parseRawAmount(quote.outputAmountRaw);
  return minimum !== null && output !== null && minimum <= output &&
    Date.parse(quote.expiresAt) > Date.parse(quote.fetchedAt);
}

/** Quote-only snapshot for simulated fills; no transaction or taker is present. */
export const paperQuoteSchema = quoteFields.extend({ kind: z.literal("paper") }).refine(
  (quote) => {
    const input = parseRawAmount(quote.inputAmountLamports);
    return quoteIsConsistent(quote) && input !== null && input <= scorePolicyV1.sizeLamports.paperMax;
  },
  "Invalid paper quote bounds or amount",
);

/** Normalized, accepted Jupiter order; unsafe routes never enter this contract. */
export const realOrderSchema = quoteFields.extend({
  kind: z.literal("real"),
  taker: solanaAddressSchema,
  signatureFeePayer: solanaAddressSchema,
  requiredSignatures: z.literal(1),
  router: z.enum(["metis", "dflow", "okx"]),
  requestId: z.string().min(1).max(200),
  transactionBase64: z.base64().max(8192),
}).refine(
  (order) => {
    const input = parseRawAmount(order.inputAmountLamports);
    return quoteIsConsistent(order) && input !== null &&
      input <= scorePolicyV1.sizeLamports.realMax && order.signatureFeePayer === order.taker;
  },
  "Invalid real order bounds, size, or fee payer",
);

export const quoteSchema = z.discriminatedUnion("kind", [paperQuoteSchema, realOrderSchema]);

export type PaperQuote = z.infer<typeof paperQuoteSchema>;
export type RealOrder = z.infer<typeof realOrderSchema>;
export type Quote = z.infer<typeof quoteSchema>;
