import { z } from "zod";
import { paymentMintSchema, paymentSizeAllowed, realTradePolicy } from "../assets.ts";
import { WRAPPED_SOL_MINT } from "../program-ids.ts";
import {
  idSchema,
  parseRawAmount,
  positiveRawAmountSchema,
  rawAmountSchema,
  solanaAddressSchema,
  timestampSchema,
} from "./primitives.ts";
import { tradeAssessmentSchema } from "./trade-assessment.ts";

const quoteFields = z.strictObject({
  network: z.enum(["mainnet", "devnet", "testnet"]).optional(),
  id: idSchema,
  signalId: idSchema,
  inputMint: paymentMintSchema,
  outputMint: solanaAddressSchema,
  inputAmountRaw: positiveRawAmountSchema,
  outputAmountRaw: positiveRawAmountSchema,
  minOutputAmountRaw: positiveRawAmountSchema,
  requestId: z.string().min(1).max(200),
  router: z.enum(["metis", "jupiterz", "dflow", "okx", "pumpswap"]),
  feeLamports: rawAmountSchema,
  fees: z.strictObject({
    totalBps: z.number().int().min(0).max(10_000),
    mint: solanaAddressSchema.nullable(),
    platform: z
      .strictObject({
        amountRaw: rawAmountSchema,
        bps: z.number().int().min(0).max(10_000),
        mint: solanaAddressSchema,
      })
      .nullable(),
    signatureLamports: rawAmountSchema,
    prioritizationLamports: rawAmountSchema,
    rentLamports: rawAmountSchema,
  }),
  slippageBps: z.number().int().min(0).max(5_000),
  priceImpactBps: z.number().int().min(0).max(10_000),
  priceImpactPct: z.number().min(-100).max(100),
  fetchedAt: timestampSchema,
  expiresAt: timestampSchema,
  assessment: tradeAssessmentSchema.optional(),
});

function quoteIsConsistent(quote: z.infer<typeof quoteFields>): boolean {
  const minimum = parseRawAmount(quote.minOutputAmountRaw);
  const output = parseRawAmount(quote.outputAmountRaw);
  const networkFees =
    (parseRawAmount(quote.fees.signatureLamports) ?? 0n) +
    (parseRawAmount(quote.fees.prioritizationLamports) ?? 0n) +
    (parseRawAmount(quote.fees.rentLamports) ?? 0n);
  return (
    ((quote.network ?? "mainnet") === "mainnet" || quote.inputMint === WRAPPED_SOL_MINT) &&
    (quote.router !== "pumpswap" ? (quote.network ?? "mainnet") === "mainnet" : quote.network === "devnet") &&
    (!quote.assessment || (quote.assessment.network ?? "mainnet") === (quote.network ?? "mainnet")) &&
    (!quote.assessment ||
      (quote.assessment.signalId === quote.signalId &&
        quote.assessment.mint.address === quote.outputMint &&
        (quote.assessment.inputMint ?? WRAPPED_SOL_MINT) === quote.inputMint &&
        quote.assessment.inputAmountRaw === quote.inputAmountRaw &&
        (quote.assessment.mode === "real" || Date.parse(quote.expiresAt) <= Date.parse(quote.assessment.expiresAt)))) &&
    minimum !== null &&
    output !== null &&
    minimum <= output &&
    Date.parse(quote.expiresAt) > Date.parse(quote.fetchedAt) &&
    parseRawAmount(quote.feeLamports) === networkFees &&
    (quote.fees.platform === null || quote.fees.platform.bps <= quote.fees.totalBps) &&
    quote.priceImpactBps === Math.round(Math.abs(quote.priceImpactPct) * 100)
  );
}

/** Quote-only snapshot for simulated fills; no transaction or taker is present. */
export const paperQuoteSchema = quoteFields
  .extend({
    kind: z.literal("paper"),
    outputDecimals: z.number().int().min(0).max(255).optional(),
    providerQuoteId: z.string().max(200).nullable(),
  })
  .refine((quote) => {
    const input = parseRawAmount(quote.inputAmountRaw);
    return (
      (!quote.assessment || quote.assessment.mode === "paper") &&
      quoteIsConsistent(quote) &&
      input !== null &&
      paymentSizeAllowed(quote.inputMint, quote.inputAmountRaw, "paper")
    );
  }, "Invalid paper quote bounds or amount");

/** Normalized, accepted Jupiter order; unsafe routes never enter this contract. */
export const realOrderSchema = quoteFields
  .extend({
    kind: z.literal("real"),
    taker: solanaAddressSchema,
    signatureFeePayer: solanaAddressSchema,
    prioritizationFeePayer: solanaAddressSchema.nullable(),
    rentFeePayer: solanaAddressSchema.nullable(),
    gasless: z.literal(false),
    requiredSignatures: z.literal(1),
    router: z.enum(["metis", "dflow", "okx", "pumpswap"]),
    lastValidBlockHeight: positiveRawAmountSchema,
    transactionBase64: z.base64().max(8192),
  })
  .refine((order) => {
    const input = parseRawAmount(order.inputAmountRaw);
    return (
      (!order.assessment || order.assessment.mode === "real") &&
      quoteIsConsistent(order) &&
      input !== null &&
      paymentSizeAllowed(order.inputMint, order.inputAmountRaw, "real") &&
      order.signatureFeePayer === order.taker &&
      order.slippageBps <= realTradePolicy.maxSlippageBps &&
      order.priceImpactBps <= realTradePolicy.maxPriceImpactBps &&
      BigInt(order.feeLamports) <= realTradePolicy.maxFeeLamports
    );
  }, "Invalid real order bounds, size, or fee payer");

export const quoteSchema = z.discriminatedUnion("kind", [paperQuoteSchema, realOrderSchema]);

export type PaperQuote = z.infer<typeof paperQuoteSchema>;
export type RealOrder = z.infer<typeof realOrderSchema>;
export type Quote = z.infer<typeof quoteSchema>;
