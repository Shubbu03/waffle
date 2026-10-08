import { z } from "zod";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WRAPPED_SOL_MINT } from "../program-ids.ts";
import { idSchema, positiveRawAmountSchema, solanaAddressSchema, timestampSchema } from "./primitives.ts";

/** Current manual-trade checks, independent of the immutable signal score v1. */
export const tradeAssessmentSchema = z
  .strictObject({
    network: z.enum(["mainnet", "devnet", "testnet"]).optional(),
    policyVersion: z.literal(1),
    signalId: idSchema,
    mode: z.enum(["paper", "real"]),
    inputAmountLamports: positiveRawAmountSchema,
    checkedAt: timestampSchema,
    expiresAt: timestampSchema,
    mint: z.strictObject({
      address: solanaAddressSchema,
      tokenProgramId: z.enum([SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]),
      decimals: z.number().int().min(0).max(255),
      mintAuthority: z.null(),
      freezeAuthority: z.null(),
      fetchedAt: timestampSchema,
    }),
    pool: z.strictObject({
      address: solanaAddressSchema,
      baseMint: solanaAddressSchema,
      quoteMint: z.literal(WRAPPED_SOL_MINT),
      liquidityUsd: z.number().finite().positive().nullable(),
      quoteReserveLamports: positiveRawAmountSchema.optional(),
      fetchedAt: timestampSchema,
    }),
    oracle: z.discriminatedUnion("source", [
      z.strictObject({ source: z.literal("none") }),
      z.strictObject({
        source: z.literal("pyth"),
        mintAddress: solanaAddressSchema,
        deviationBps: z.number().finite().min(0).max(1000),
        fetchedAt: timestampSchema,
        expiresAt: timestampSchema,
      }),
    ]),
  })
  .refine(
    (value) => value.mint.address === value.pool.baseMint && Date.parse(value.expiresAt) > Date.parse(value.checkedAt),
    "Invalid current assessment",
  );
export type TradeAssessment = z.infer<typeof tradeAssessmentSchema>;
