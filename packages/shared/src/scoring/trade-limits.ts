import { scorePolicyV1 } from "./config.ts";

export type TradeMode = "paper" | "real";
export type TradeLimitResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "invalid_mode" | "invalid_size" | "size_cap" | "liquidity_stale" | "liquidity_floor";
    };

/** Final quote and wallet-route checks remain separate from this size/liquidity gate. */
export function checkTradeLimits(
  mode: string,
  amountLamports: bigint,
  liquidityUsd: number,
  liquidityFetchedAtMs: number,
  nowMs: number,
): TradeLimitResult {
  if (mode !== "paper" && mode !== "real") return { allowed: false, reason: "invalid_mode" };
  if (amountLamports <= 0n) return { allowed: false, reason: "invalid_size" };

  const cap = mode === "real" ? scorePolicyV1.sizeLamports.realMax : scorePolicyV1.sizeLamports.paperMax;
  if (amountLamports > cap) return { allowed: false, reason: "size_cap" };

  const age = nowMs - liquidityFetchedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > scorePolicyV1.freshness.poolMs) {
    return { allowed: false, reason: "liquidity_stale" };
  }

  const floor = mode === "real" ? scorePolicyV1.liquidityUsd.real : scorePolicyV1.liquidityUsd.signalAndPaper;
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < floor) {
    return { allowed: false, reason: "liquidity_floor" };
  }

  return { allowed: true };
}
