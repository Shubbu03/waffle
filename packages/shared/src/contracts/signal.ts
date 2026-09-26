import { z } from "zod";
import { SPL_TOKEN_PROGRAM_ID, WRAPPED_SOL_MINT } from "../program-ids.ts";
import { scorePolicyV1 } from "../scoring/config.ts";
import { SCORE_REASON_CODES, SCORE_REASON_GROUPS } from "../scoring/score.ts";
import {
  eventCursorSchema,
  idSchema,
  parseRawAmount,
  positiveRawAmountSchema,
  slotSchema,
  solanaAddressSchema,
  timestampSchema,
  transactionSignatureSchema,
} from "./primitives.ts";

export const scoreReasonSchema = z.strictObject({
  code: z.enum(SCORE_REASON_CODES),
  points: z.number().int().min(0).max(100),
});

export const signalSummarySchema = z.strictObject({
  id: idSchema,
  eventId: eventCursorSchema,
  signature: transactionSignatureSchema,
  walletId: idSchema,
  walletAddress: solanaAddressSchema,
  mintAddress: solanaAddressSchema,
  sourceProgramId: solanaAddressSchema,
  slot: slotSchema,
  observedAt: timestampSchema,
  publishedAt: timestampSchema,
  scoreVersion: z.literal(1),
  score: z.number().int().min(0).max(100),
  status: z.enum(["eligible", "history-only", "suppressed"]),
  dataStatus: z.enum(["complete", "partial", "stale", "unknown"]),
});

const mintEvidenceSchema = z.strictObject({
  address: solanaAddressSchema,
  tokenProgramId: solanaAddressSchema,
  mintAuthority: solanaAddressSchema.nullable(),
  freezeAuthority: solanaAddressSchema.nullable(),
  fetchedAt: timestampSchema,
});

const poolEvidenceSchema = z.strictObject({
  baseMint: solanaAddressSchema,
  quoteMint: solanaAddressSchema,
  liquidityUsd: z.number().finite().min(0),
  fetchedAt: timestampSchema,
});

const quoteEvidenceSchema = z.strictObject({
  inputMint: solanaAddressSchema,
  outputMint: solanaAddressSchema,
  inputLamports: positiveRawAmountSchema,
  outputAmountRaw: positiveRawAmountSchema,
  fetchedAt: timestampSchema,
});

const evidenceStateSchema = z.strictObject({
  status: z.enum(["fresh", "stale", "unknown"]),
  expiresAt: timestampSchema.nullable(),
  reason: z.string().max(100).nullable(),
});

export const scoreSnapshotSchema = z.strictObject({
  assessment: z
    .strictObject({
      scoredAt: timestampSchema,
      transactionAt: timestampSchema.nullable(),
      source: z.enum(["provisional", "backfill"]),
      streamStale: z.boolean(),
      evidence: z.strictObject({
        mint: evidenceStateSchema,
        pool: evidenceStateSchema,
        quote: evidenceStateSchema,
        holders: evidenceStateSchema,
        creator: evidenceStateSchema,
        oracle: evidenceStateSchema,
      }),
    })
    .optional(),
  transactionSlot: slotSchema,
  currentSlot: slotSchema,
  mint: mintEvidenceSchema.nullable(),
  pool: poolEvidenceSchema.nullable(),
  quote: quoteEvidenceSchema.nullable(),
  holders: z
    .strictObject({
      top10Pct: z.number().finite().min(0).max(100),
      fetchedAt: timestampSchema,
    })
    .nullable(),
  creator: z
    .strictObject({
      holdingPct: z.number().finite().min(0).max(100),
      fetchedAt: timestampSchema,
    })
    .nullable(),
  oracle: z
    .strictObject({
      mintAddress: solanaAddressSchema,
      deviationBps: z.number().finite().min(0),
      fetchedAt: timestampSchema,
    })
    .nullable(),
});

const scoredFields = {
  reasons: z.array(scoreReasonSchema).max(SCORE_REASON_CODES.length),
  snapshot: scoreSnapshotSchema,
};
const scoredSignalBaseSchema = signalSummarySchema
  .omit({ id: true, eventId: true, walletId: true, publishedAt: true })
  .extend(scoredFields);

function validateScore(signal: z.infer<typeof scoredSignalBaseSchema>, context: z.RefinementCtx) {
  if (signal.reasons.length !== SCORE_REASON_GROUPS.length) {
    context.addIssue({ code: "custom", path: ["reasons"], message: "Expected one reason per score bucket" });
    return;
  }

  for (const [index, group] of SCORE_REASON_GROUPS.entries()) {
    const reason = signal.reasons[index];
    if (reason === undefined) continue;
    const matches =
      reason.code === group.pass ||
      reason.code === group.fail ||
      ("alternateFail" in group && reason.code === group.alternateFail);
    const expectedPoints = reason.code === group.pass ? group.points : 0;
    if (!matches || reason.points !== expectedPoints) {
      context.addIssue({
        code: "custom",
        path: ["reasons", index],
        message: "Reason code or points do not match score v1",
      });
    }
  }

  if (signal.reasons.reduce((total, reason) => total + reason.points, 0) !== signal.score) {
    context.addIssue({ code: "custom", path: ["score"], message: "Score must equal awarded reason points" });
  }

  const codes = new Set(signal.reasons.map((reason) => reason.code));
  const suppressed = [
    "unsupported_or_failed_transaction",
    "mint_unavailable_or_unsafe",
    "pool_unavailable_or_shallow",
    "quote_unavailable",
    "oracle_deviation_high",
  ].some((code) => codes.has(code as (typeof SCORE_REASON_CODES)[number]));
  const expectedStatus = suppressed ? "suppressed" : codes.has("stale_signal") ? "history-only" : "eligible";
  if (signal.status !== expectedStatus) {
    context.addIssue({ code: "custom", path: ["status"], message: "Status does not match critical score reasons" });
  }

  const { snapshot } = signal;
  if (
    codes.has("mint_safe") &&
    (snapshot.mint === null ||
      snapshot.mint.address !== signal.mintAddress ||
      snapshot.mint.tokenProgramId !== SPL_TOKEN_PROGRAM_ID ||
      snapshot.mint.mintAuthority !== null ||
      snapshot.mint.freezeAuthority !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "mint"],
      message: "Mint evidence does not support the awarded points",
    });
  }
  if (
    codes.has("pool_liquid") &&
    (snapshot.pool === null ||
      snapshot.pool.baseMint !== signal.mintAddress ||
      snapshot.pool.quoteMint !== WRAPPED_SOL_MINT ||
      snapshot.pool.liquidityUsd < scorePolicyV1.liquidityUsd.signalAndPaper)
  ) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "pool"],
      message: "Pool evidence does not support the awarded points",
    });
  }
  if (
    codes.has("quote_available") &&
    (snapshot.quote === null ||
      snapshot.quote.inputMint !== WRAPPED_SOL_MINT ||
      snapshot.quote.outputMint !== signal.mintAddress ||
      (parseRawAmount(snapshot.quote.inputLamports) ?? 0n) < scorePolicyV1.sizeLamports.quoteProbe)
  ) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "quote"],
      message: "Quote evidence does not support the awarded points",
    });
  }
  if (
    codes.has("holders_acceptable") &&
    (snapshot.holders === null || snapshot.holders.top10Pct > scorePolicyV1.optional.maxTop10HolderPct)
  ) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "holders"],
      message: "Holder evidence does not support the awarded points",
    });
  }
  if (
    codes.has("creator_acceptable") &&
    (snapshot.creator === null || snapshot.creator.holdingPct > scorePolicyV1.optional.maxCreatorHoldingPct)
  ) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "creator"],
      message: "Creator evidence does not support the awarded points",
    });
  }
  if (
    codes.has("oracle_agrees") &&
    (snapshot.oracle === null ||
      snapshot.oracle.mintAddress !== signal.mintAddress ||
      snapshot.oracle.deviationBps > scorePolicyV1.optional.maxOracleDeviationBpsForPoints)
  ) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "oracle"],
      message: "Oracle evidence does not support the awarded points",
    });
  }
}

/** Internal watcher write contract, before database-generated IDs and publication time. */
export const scoredSignalSchema = scoredSignalBaseSchema.superRefine(validateScore);
export type ScoredSignal = z.infer<typeof scoredSignalSchema>;
export const signalDetailSchema = signalSummarySchema.extend(scoredFields).superRefine(validateScore);

export type ScoreReasonDto = z.infer<typeof scoreReasonSchema>;
export type SignalSummary = z.infer<typeof signalSummarySchema>;
export type SignalDetail = z.infer<typeof signalDetailSchema>;
export type ScoreSnapshot = z.infer<typeof scoreSnapshotSchema>;
