import { z } from "zod";
import { WRAPPED_SOL_MINT } from "../program-ids.ts";
import { scorePolicyV1 } from "../scoring/config.ts";
import {
  idSchema,
  parseRawAmount,
  positiveRawAmountSchema,
  rawAmountSchema,
  solanaAddressSchema,
  transactionSignatureSchema,
} from "./primitives.ts";

const amountAtMost = (maximum: bigint) =>
  positiveRawAmountSchema.refine(
    (value) => (parseRawAmount(value) ?? 0n) <= maximum,
    "Amount exceeds the allowed size",
  );

const quoteRequestFields = {
  signalId: idSchema,
  outputMint: solanaAddressSchema,
} as const;

export const jupiterPaperQuoteRequestSchema = z
  .strictObject({
    ...quoteRequestFields,
    inputAmountLamports: amountAtMost(scorePolicyV1.sizeLamports.paperMax),
  })
  .refine((request) => request.outputMint !== WRAPPED_SOL_MINT, "Output mint must differ from SOL");

export const jupiterRealOrderRequestSchema = z
  .strictObject({
    ...quoteRequestFields,
    inputAmountLamports: amountAtMost(scorePolicyV1.sizeLamports.realMax),
    taker: solanaAddressSchema,
  })
  .refine((request) => request.outputMint !== WRAPPED_SOL_MINT, "Output mint must differ from SOL");

export const jupiterExecuteRequestSchema = z.strictObject({
  orderId: idSchema,
  requestId: z.string().min(1).max(200),
  signedTransactionBase64: z.base64().min(1).max(8192),
});

export const jupiterExecutionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("confirmed"),
    requestId: z.string().min(1).max(200),
    code: z.literal(0),
    signature: transactionSignatureSchema,
    totalInputAmountRaw: rawAmountSchema,
    totalOutputAmountRaw: rawAmountSchema,
    inputAmountResultRaw: rawAmountSchema,
    outputAmountResultRaw: rawAmountSchema,
  }),
  z.strictObject({
    status: z.literal("failed"),
    requestId: z.string().min(1).max(200),
    code: z.number().int().min(-10_000).max(-1),
    signature: transactionSignatureSchema.nullable(),
  }),
]);

export type JupiterPaperQuoteRequest = z.infer<typeof jupiterPaperQuoteRequestSchema>;
export type JupiterRealOrderRequest = z.infer<typeof jupiterRealOrderRequestSchema>;
export type JupiterExecuteRequest = z.infer<typeof jupiterExecuteRequestSchema>;
export type JupiterExecutionResult = z.infer<typeof jupiterExecutionResultSchema>;
