import { z } from "zod";
import { paymentMintSchema, paymentSizeAllowed } from "../assets.ts";
import { WRAPPED_SOL_MINT } from "../program-ids.ts";
import {
  idSchema,
  positiveRawAmountSchema,
  rawAmountSchema,
  solanaAddressSchema,
  transactionSignatureSchema,
} from "./primitives.ts";

const quoteRequestFields = {
  signalId: idSchema,
  outputMint: solanaAddressSchema,
} as const;

export const jupiterPaperQuoteRequestSchema = z
  .strictObject({
    ...quoteRequestFields,
    inputMint: paymentMintSchema.default(WRAPPED_SOL_MINT),
    inputAmountRaw: positiveRawAmountSchema,
  })
  .refine(
    (request) =>
      request.outputMint !== request.inputMint &&
      paymentSizeAllowed(request.inputMint, request.inputAmountRaw, "paper"),
    "Invalid input asset or size",
  );

export const jupiterRealOrderRequestSchema = z
  .strictObject({
    ...quoteRequestFields,
    inputMint: paymentMintSchema.default(WRAPPED_SOL_MINT),
    inputAmountRaw: positiveRawAmountSchema,
    taker: solanaAddressSchema,
  })
  .refine(
    (request) =>
      request.outputMint !== request.inputMint && paymentSizeAllowed(request.inputMint, request.inputAmountRaw, "real"),
    "Invalid input asset or size",
  );

export const jupiterExecuteRequestSchema = z.strictObject({
  orderId: idSchema,
  requestId: z.string().min(1).max(200),
  signedTransactionBase64: z.base64().min(1).max(8192),
});

export const jupiterExecutionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("expired"),
    requestId: z.string().min(1).max(200),
    code: z.literal(-9999),
    signature: transactionSignatureSchema,
  }),
  z.strictObject({
    status: z.literal("confirmed"),
    requestId: z.string().min(1).max(200),
    code: z.literal(0),
    signature: transactionSignatureSchema,
    feeLamports: rawAmountSchema.optional(),
    outputDecimals: z.number().int().min(0).max(255).optional(),
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
