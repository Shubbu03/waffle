import { classifyPumpSwapBuy } from "@waffle/market-data/classify";
import { TokenEvidenceCollector } from "@waffle/market-data/evidence";
import { PythPrices } from "@waffle/market-data/pyth";
import type { MarketRpc } from "@waffle/market-data/rpc";
import {
  type ApiErrorCode,
  checkTradeLimits,
  PUMP_SWAP_PROGRAM_ID,
  type SignalDetail,
  scorePolicyV1,
  type TradeAssessment,
  type TradeMode,
  tradeAssessmentSchema,
} from "@waffle/shared";
import type { JupiterService } from "./jupiter.ts";

export class TradeAssessmentError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export type TradeAssessor = {
  assess(signal: SignalDetail, mode: TradeMode, size: string): Promise<TradeAssessment>;
};

/** History status and stream health govern alerts, not a new manual assessment. */
export function assertSupportedSignal(signal: SignalDetail) {
  if (
    signal.sourceProgramId !== PUMP_SWAP_PROGRAM_ID ||
    !signal.reasons.some((r) => r.code === "supported_buy" && r.points === 20)
  )
    throw new TradeAssessmentError("STALE_SIGNAL", 409, "This transaction is not a confirmed supported buy.");
}

/** Also run at issuance and confirmation: provider latency never renews evidence timestamps. */
export function assertTradeAssessment(
  value: TradeAssessment,
  signal: SignalDetail,
  mode: TradeMode,
  size: string,
  now: number,
) {
  const parsed = tradeAssessmentSchema.safeParse(value);
  if (!parsed.success)
    throw new TradeAssessmentError("SERVICE_UNAVAILABLE", 503, "Current trade checks are invalid. Try again.");
  const a = parsed.data;
  if (
    a.signalId !== signal.id ||
    a.mint.address !== signal.mintAddress ||
    a.mode !== mode ||
    a.inputAmountLamports !== size
  )
    throw new TradeAssessmentError("CONFLICT", 409, "Trade checks do not match this token and size.");
  const mintAge = now - Date.parse(a.mint.fetchedAt);
  if (
    Date.parse(a.checkedAt) > now ||
    Date.parse(a.expiresAt) <= now ||
    mintAge < 0 ||
    mintAge >= scorePolicyV1.freshness.mintMs
  )
    throw new TradeAssessmentError("QUOTE_UNAVAILABLE", 409, "Trade checks expired. Request a fresh quote.");
  if (a.network === "devnet") {
    const reserve = BigInt(a.pool.quoteReserveLamports ?? "0");
    if (
      a.pool.liquidityUsd !== null ||
      reserve < 1_000_000_000n ||
      BigInt(size) * 100n > reserve ||
      BigInt(size) > scorePolicyV1.sizeLamports[mode === "real" ? "realMax" : "paperMax"]
    )
      throw new TradeAssessmentError(
        "LIMIT_EXCEEDED",
        409,
        "Devnet pool needs at least 1 test SOL and the trade must be at most 1% of its SOL reserve.",
      );
    if (now < Date.parse(a.pool.fetchedAt) || now - Date.parse(a.pool.fetchedAt) >= 60_000)
      throw new TradeAssessmentError("QUOTE_UNAVAILABLE", 409, "Devnet pool checks expired. Request another quote.");
  } else {
    if ((a.network ?? "mainnet") !== "mainnet" || a.pool.liquidityUsd === null)
      throw new TradeAssessmentError("UNSUPPORTED_ROUTE", 409, "PumpSwap trading is unavailable on this network.");
    const gate = checkTradeLimits(mode, BigInt(size), a.pool.liquidityUsd, Date.parse(a.pool.fetchedAt), now);
    if (!gate.allowed)
      throw new TradeAssessmentError(
        gate.reason === "liquidity_stale" ? "QUOTE_UNAVAILABLE" : "LIMIT_EXCEEDED",
        409,
        gate.reason === "liquidity_floor"
          ? `Current pool liquidity must be at least $${mode === "real" ? "75,000" : "25,000"}.`
          : "Trade size or current liquidity checks failed.",
      );
  }
  if (a.oracle.source === "pyth") {
    const age = now - Date.parse(a.oracle.fetchedAt);
    if (
      a.oracle.mintAddress !== signal.mintAddress ||
      age < 0 ||
      age >= scorePolicyV1.freshness.oracleMs ||
      now >= Date.parse(a.oracle.expiresAt)
    )
      throw new TradeAssessmentError("QUOTE_UNAVAILABLE", 409, "Price checks expired. Request a fresh quote.");
  }
}

export function createTradeAssessor(options: {
  rpc: Pick<MarketRpc, "getTransaction" | "getMultipleAccounts" | "getBlockTime">;
  jupiter: Pick<JupiterService, "getPaperQuote" | "getUsdPrice">;
  pyth?: Pick<PythPrices, "get">;
  now?: () => number;
}): TradeAssessor {
  const now = options.now ?? Date.now;
  return {
    async assess(signal, mode, size) {
      assertSupportedSignal(signal);
      try {
        // Derive the pool from the confirmed source transaction, never from mobile input.
        const tx = await options.rpc.getTransaction(signal.signature);
        const result = classifyPumpSwapBuy(tx, signal.walletAddress, signal.signature);
        if (result.status !== "buy" || result.buy.mintAddress !== signal.mintAddress || result.buy.slot !== signal.slot)
          throw new TradeAssessmentError(
            "STALE_SIGNAL",
            409,
            "The source transaction could not be verified as this token buy.",
          );
        // New collector per review: fetch current accounts; do not rejuvenate the saved signal snapshot.
        const checks = await new TokenEvidenceCollector({
          rpc: options.rpc,
          jupiter: options.jupiter,
          pyth: options.pyth ?? new PythPrices({ feeds: {} }),
          now,
        }).collect(result.buy, { quote: false });
        if (checks.mint.status !== "fresh")
          throw new TradeAssessmentError("SERVICE_UNAVAILABLE", 503, "Unable to verify the token now. Try again.");
        if (checks.mint.value.mintAuthority || checks.mint.value.freezeAuthority)
          throw new TradeAssessmentError("STALE_SIGNAL", 409, "This token has mint or freeze controls enabled.");
        if (checks.pool.status !== "fresh")
          throw new TradeAssessmentError(
            "SERVICE_UNAVAILABLE",
            503,
            "Unable to verify current pool liquidity. Try again.",
          );
        if (
          checks.oracle.source === "pyth" &&
          checks.oracle.deviationBps > scorePolicyV1.optional.suppressOracleDeviationBps
        )
          throw new TradeAssessmentError(
            "STALE_SIGNAL",
            409,
            "The current pool price differs too much from its oracle.",
          );
        const iso = (ms: number) => new Date(ms).toISOString();
        const expiresAt = Math.min(
          checks.mint.expiresAtMs,
          checks.pool.expiresAtMs,
          checks.oracle.source === "pyth" ? checks.oracle.expiresAtMs : Infinity,
        );
        const assessment = tradeAssessmentSchema.parse({
          policyVersion: 1,
          signalId: signal.id,
          mode,
          inputAmountLamports: size,
          checkedAt: iso(now()),
          expiresAt: iso(expiresAt),
          mint: {
            address: checks.mint.value.address,
            tokenProgramId: checks.mint.value.tokenProgramId,
            decimals: checks.mint.value.decimals,
            mintAuthority: null,
            freezeAuthority: null,
            fetchedAt: iso(checks.mint.fetchedAtMs),
          },
          pool: {
            address: checks.pool.value.address,
            baseMint: checks.pool.value.baseMint,
            quoteMint: checks.pool.value.quoteMint,
            liquidityUsd: checks.pool.value.liquidityUsd,
            fetchedAt: iso(checks.pool.fetchedAtMs),
          },
          oracle:
            checks.oracle.source === "none"
              ? { source: "none" }
              : {
                  source: "pyth",
                  mintAddress: checks.oracle.mintAddress,
                  deviationBps: checks.oracle.deviationBps,
                  fetchedAt: iso(checks.oracle.fetchedAtMs),
                  expiresAt: iso(checks.oracle.expiresAtMs),
                },
        });
        assertTradeAssessment(assessment, signal, mode, size, now());
        return assessment;
      } catch (error) {
        if (error instanceof TradeAssessmentError) throw error;
        // RPC/Xior errors can contain provider credentials; never expose them in messages or causes.
        throw new TradeAssessmentError("SERVICE_UNAVAILABLE", 503, "Current trade checks are unavailable. Try again.");
      }
    },
  };
}
