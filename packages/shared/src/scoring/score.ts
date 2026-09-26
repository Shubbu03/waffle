import { SPL_TOKEN_PROGRAM_ID, scorePolicyV1, WRAPPED_SOL_MINT } from "./config.ts";

export type ScoreInput = {
  readonly mintAddress: string;
  readonly supportedBuy: boolean;
  readonly transactionSucceeded: boolean;
  readonly transactionSlot: number;
  readonly observedAtMs: number;
  readonly currentSlot: number;
  readonly nowMs: number;
  /** Transport health is separate from slot age; a caught-up slot alone cannot prove a healthy stream. */
  readonly streamStale?: boolean;
  /** Present for ingested transactions; null means block time is unavailable. */
  readonly transactionAtMs?: number | null;
  readonly mint: null | {
    readonly address: string;
    readonly tokenProgramId: string;
    readonly mintAuthority: string | null;
    readonly freezeAuthority: string | null;
    readonly fetchedAtMs: number;
  };
  readonly pool: null | {
    readonly baseMint: string;
    readonly quoteMint: string;
    readonly liquidityUsd: number;
    readonly fetchedAtMs: number;
  };
  readonly quote: null | {
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inputLamports: bigint;
    readonly outputAmountRaw: bigint;
    readonly fetchedAtMs: number;
  };
  readonly holders: null | {
    readonly top10Pct: number;
    readonly fetchedAtMs: number;
  };
  readonly creator: null | {
    readonly holdingPct: number;
    readonly fetchedAtMs: number;
  };
  readonly oracle: null | {
    readonly mintAddress: string;
    readonly deviationBps: number;
    readonly fetchedAtMs: number;
  };
};

export const SCORE_REASON_CODES = [
  "supported_buy",
  "unsupported_or_failed_transaction",
  "fresh_signal",
  "stale_signal",
  "mint_safe",
  "mint_unavailable_or_unsafe",
  "pool_liquid",
  "pool_unavailable_or_shallow",
  "quote_available",
  "quote_unavailable",
  "holders_acceptable",
  "holders_missing_stale_or_concentrated",
  "creator_acceptable",
  "creator_missing_stale_or_concentrated",
  "oracle_agrees",
  "oracle_none_or_stale",
  "oracle_deviation_high",
] as const;

export type ScoreReasonCode = (typeof SCORE_REASON_CODES)[number];

export const SCORE_REASON_GROUPS = [
  { pass: "supported_buy", fail: "unsupported_or_failed_transaction", points: scorePolicyV1.weights.supportedBuy },
  { pass: "fresh_signal", fail: "stale_signal", points: scorePolicyV1.weights.freshness },
  { pass: "mint_safe", fail: "mint_unavailable_or_unsafe", points: scorePolicyV1.weights.mint },
  { pass: "pool_liquid", fail: "pool_unavailable_or_shallow", points: scorePolicyV1.weights.pool },
  { pass: "quote_available", fail: "quote_unavailable", points: scorePolicyV1.weights.quote },
  { pass: "holders_acceptable", fail: "holders_missing_stale_or_concentrated", points: scorePolicyV1.weights.holders },
  { pass: "creator_acceptable", fail: "creator_missing_stale_or_concentrated", points: scorePolicyV1.weights.creator },
  {
    pass: "oracle_agrees",
    fail: "oracle_none_or_stale",
    alternateFail: "oracle_deviation_high",
    points: scorePolicyV1.weights.oracle,
  },
] as const;

export type ScoreReason = { readonly code: ScoreReasonCode; readonly points: number };

export type ScoreResult = {
  readonly scoreVersion: 1;
  readonly score: number;
  readonly reasons: readonly ScoreReason[];
  readonly status: "eligible" | "history-only" | "suppressed";
  readonly optionalDataComplete: boolean;
  readonly canAlert: boolean;
};

const isFresh = (nowMs: number, fetchedAtMs: number, maxAgeMs: number): boolean =>
  Number.isFinite(nowMs) && Number.isFinite(fetchedAtMs) && fetchedAtMs <= nowMs && nowMs - fetchedAtMs <= maxAgeMs;

const validPercent = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 100;

/** Scores a confirmed, classified transaction snapshot; no network calls or mutable state. */
export function scoreSignal(input: ScoreInput): ScoreResult {
  const { weights, freshness, optional } = scorePolicyV1;
  const reasons: ScoreReason[] = [];
  let score = 0;
  let criticalFailed = false;

  const award = (passed: boolean, pass: ScoreReasonCode, fail: ScoreReasonCode, points: number) => {
    reasons.push({ code: passed ? pass : fail, points: passed ? points : 0 });
    if (passed) score += points;
    return passed;
  };

  const buyOkay = award(
    input.supportedBuy && input.transactionSucceeded,
    "supported_buy",
    "unsupported_or_failed_transaction",
    weights.supportedBuy,
  );
  if (!buyOkay) criticalFailed = true;

  const slotLag = input.currentSlot - input.transactionSlot;
  const signalFresh = award(
    input.streamStale !== true &&
      (input.transactionAtMs === undefined ||
        (input.transactionAtMs !== null && isFresh(input.nowMs, input.transactionAtMs, freshness.signalMs))) &&
      Number.isSafeInteger(input.currentSlot) &&
      Number.isSafeInteger(input.transactionSlot) &&
      input.transactionSlot >= 0 &&
      slotLag >= 0 &&
      slotLag <= freshness.signalSlots &&
      isFresh(input.nowMs, input.observedAtMs, freshness.signalMs),
    "fresh_signal",
    "stale_signal",
    weights.freshness,
  );

  const mintOkay = award(
    input.mint !== null &&
      input.mint.address === input.mintAddress &&
      input.mint.tokenProgramId === SPL_TOKEN_PROGRAM_ID &&
      input.mint.mintAuthority === null &&
      input.mint.freezeAuthority === null &&
      isFresh(input.nowMs, input.mint.fetchedAtMs, freshness.mintMs),
    "mint_safe",
    "mint_unavailable_or_unsafe",
    weights.mint,
  );
  if (!mintOkay) criticalFailed = true;

  const poolOkay = award(
    input.pool !== null &&
      input.pool.baseMint === input.mintAddress &&
      input.pool.quoteMint === WRAPPED_SOL_MINT &&
      Number.isFinite(input.pool.liquidityUsd) &&
      input.pool.liquidityUsd >= scorePolicyV1.liquidityUsd.signalAndPaper &&
      isFresh(input.nowMs, input.pool.fetchedAtMs, freshness.poolMs),
    "pool_liquid",
    "pool_unavailable_or_shallow",
    weights.pool,
  );
  if (!poolOkay) criticalFailed = true;

  const quoteOkay = award(
    input.quote !== null &&
      input.quote.inputMint === WRAPPED_SOL_MINT &&
      input.quote.outputMint === input.mintAddress &&
      input.quote.inputLamports >= scorePolicyV1.sizeLamports.quoteProbe &&
      input.quote.outputAmountRaw > 0n &&
      isFresh(input.nowMs, input.quote.fetchedAtMs, freshness.quoteMs),
    "quote_available",
    "quote_unavailable",
    weights.quote,
  );
  if (!quoteOkay) criticalFailed = true;

  const holdersOkay = award(
    input.holders !== null &&
      validPercent(input.holders.top10Pct) &&
      input.holders.top10Pct <= optional.maxTop10HolderPct &&
      isFresh(input.nowMs, input.holders.fetchedAtMs, freshness.holdersMs),
    "holders_acceptable",
    "holders_missing_stale_or_concentrated",
    weights.holders,
  );

  const creatorOkay = award(
    input.creator !== null &&
      validPercent(input.creator.holdingPct) &&
      input.creator.holdingPct <= optional.maxCreatorHoldingPct &&
      isFresh(input.nowMs, input.creator.fetchedAtMs, freshness.creatorMs),
    "creator_acceptable",
    "creator_missing_stale_or_concentrated",
    weights.creator,
  );

  const oracle = input.oracle;
  const oracleUsable =
    oracle !== null &&
    oracle.mintAddress === input.mintAddress &&
    Number.isFinite(oracle.deviationBps) &&
    oracle.deviationBps >= 0 &&
    isFresh(input.nowMs, oracle.fetchedAtMs, freshness.oracleMs);
  const oracleDeviationHigh =
    oracle !== null && oracleUsable && oracle.deviationBps > optional.suppressOracleDeviationBps;
  const oracleOkay = award(
    oracle !== null && oracleUsable && oracle.deviationBps <= optional.maxOracleDeviationBpsForPoints,
    "oracle_agrees",
    oracleDeviationHigh ? "oracle_deviation_high" : "oracle_none_or_stale",
    weights.oracle,
  );
  if (oracleDeviationHigh) criticalFailed = true;

  const status = criticalFailed ? "suppressed" : !signalFresh ? "history-only" : "eligible";
  return {
    scoreVersion: scorePolicyV1.version,
    score,
    reasons,
    status,
    optionalDataComplete: holdersOkay && creatorOkay && oracleOkay,
    canAlert: status === "eligible" && score >= scorePolicyV1.alertThreshold,
  };
}
