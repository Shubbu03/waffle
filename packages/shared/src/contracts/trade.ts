import { z } from "zod";
import { paymentMintSchema, paymentSizeAllowed } from "../assets.ts";
import { WRAPPED_SOL_MINT } from "../program-ids.ts";
import { jupiterExecuteRequestSchema } from "./jupiter.ts";
import {
  idSchema,
  positiveRawAmountSchema,
  rawAmountSchema,
  solanaAddressSchema,
  timestampSchema,
  transactionSignatureSchema,
} from "./primitives.ts";
import { realOrderSchema } from "./quote.ts";

export const createTradeAttemptRequestSchema = z
  .strictObject({
    signalId: idSchema,
    inputMint: paymentMintSchema.default(WRAPPED_SOL_MINT),
    inputAmountRaw: positiveRawAmountSchema,
  })
  .refine(
    (value) => paymentSizeAllowed(value.inputMint, value.inputAmountRaw, "real"),
    "Real size exceeds the asset limit",
  );

export const tradeAttemptSchema = z
  .strictObject({
    id: idSchema,
    signalId: idSchema,
    quoteId: idSchema,
    requestId: z.string().min(1).max(200),
    taker: solanaAddressSchema,
    router: z.enum(["metis", "dflow", "okx", "pumpswap"]),
    inputAmountRaw: positiveRawAmountSchema,
    inputMint: paymentMintSchema.default(WRAPPED_SOL_MINT),
    outputMint: solanaAddressSchema.nullable().default(null),
    receipt: z
      .strictObject({
        inputAmountRaw: rawAmountSchema,
        outputAmountRaw: rawAmountSchema,
        feeLamports: rawAmountSchema.nullable(),
        outputDecimals: z.number().int().min(0).max(255).nullable(),
      })
      .nullable()
      .default(null),
    status: z.enum(["prepared", "wallet_rejected", "submitted", "confirmed", "failed", "expired"]),
    signature: transactionSignatureSchema.nullable(),
    executeCode: z.number().int().min(-10_000).max(0).nullable(),
    failureReason: z.string().max(200).nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine((attempt) => {
    switch (attempt.status) {
      case "prepared":
        return attempt.signature === null && attempt.executeCode === null && attempt.failureReason === null;
      case "wallet_rejected":
        return attempt.signature === null && attempt.failureReason !== null;
      case "confirmed":
        return attempt.signature !== null && attempt.executeCode === 0 && attempt.failureReason === null;
      case "expired":
      case "failed":
        return attempt.failureReason !== null || attempt.executeCode !== null;
      case "submitted":
        return true;
    }
  }, "Trade attempt status and outcome fields are inconsistent");

export type CreateTradeAttemptRequest = z.infer<typeof createTradeAttemptRequestSchema>;
export type TradeAttempt = z.infer<typeof tradeAttemptSchema>;

/** The order comes only from the server's validated Jupiter service. */
export const tradeAttemptOrderResponseSchema = z.strictObject({ order: realOrderSchema, attempt: tradeAttemptSchema });
export const executeTradeAttemptRequestSchema = jupiterExecuteRequestSchema
  .omit({ orderId: true })
  .extend({ quoteId: idSchema });
export const rejectTradeAttemptRequestSchema = z.strictObject({
  quoteId: idSchema,
  requestId: z.string().min(1).max(200),
  reason: z.enum(["WALLET_REJECTED", "USER_CANCELLED"]),
});
export const getTradeAttemptsQuerySchema = z.strictObject({
  signalId: idSchema.optional(),
  cursor: idSchema.optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d?$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .default(50),
});
export type ExecuteTradeAttemptRequest = z.infer<typeof executeTradeAttemptRequestSchema>;
export type RejectTradeAttemptRequest = z.infer<typeof rejectTradeAttemptRequestSchema>;
export type GetTradeAttemptsQuery = z.output<typeof getTradeAttemptsQuerySchema>;
