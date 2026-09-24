import { z } from "zod";
import { scorePolicyV1 } from "../scoring/config.ts";
import {
  idSchema,
  parseRawAmount,
  positiveRawAmountSchema,
  solanaAddressSchema,
  timestampSchema,
  transactionSignatureSchema,
} from "./primitives.ts";

export const createTradeAttemptRequestSchema = z.strictObject({
  signalId: idSchema,
  quoteId: idSchema,
  inputAmountLamports: positiveRawAmountSchema.refine(
    (value) => {
      const amount = parseRawAmount(value);
      return amount !== null && amount <= scorePolicyV1.sizeLamports.realMax;
    },
    "Real size exceeds 0.05 SOL",
  ),
});

export const tradeAttemptSchema = z.strictObject({
  id: idSchema,
  signalId: idSchema,
  quoteId: idSchema,
  requestId: z.string().min(1).max(200),
  taker: solanaAddressSchema,
  router: z.enum(["metis", "dflow", "okx"]),
  inputAmountLamports: positiveRawAmountSchema,
  status: z.enum(["prepared", "wallet_rejected", "submitted", "confirmed", "failed"]),
  signature: transactionSignatureSchema.nullable(),
  executeCode: z.number().int().min(-10_000).max(0).nullable(),
  failureReason: z.string().max(200).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).refine((attempt) => {
  switch (attempt.status) {
    case "prepared":
      return attempt.signature === null && attempt.executeCode === null && attempt.failureReason === null;
    case "wallet_rejected":
      return attempt.signature === null && attempt.failureReason !== null;
    case "confirmed":
      return attempt.signature !== null && attempt.executeCode === 0 && attempt.failureReason === null;
    case "failed":
      return attempt.failureReason !== null || attempt.executeCode !== null;
    case "submitted":
      return true;
  }
}, "Trade attempt status and outcome fields are inconsistent");

export type CreateTradeAttemptRequest = z.infer<typeof createTradeAttemptRequestSchema>;
export type TradeAttempt = z.infer<typeof tradeAttemptSchema>;
