import { describe, expect, test } from "bun:test";
import {
  checkTradeLimits,
  type ScoreInput,
  SPL_TOKEN_PROGRAM_ID,
  scorePolicyV1,
  scoreSignal,
  WRAPPED_SOL_MINT,
} from "../src/index.ts";

const mintAddress = "test-mint";
const nowMs = 1_000_000;

function readyInput(): ScoreInput {
  return {
    mintAddress,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: 1_000,
    currentSlot: 1_001,
    observedAtMs: nowMs - 1_000,
    nowMs,
    mint: {
      address: mintAddress,
      tokenProgramId: SPL_TOKEN_PROGRAM_ID,
      mintAuthority: null,
      freezeAuthority: null,
      fetchedAtMs: nowMs - 1_000,
    },
    pool: {
      baseMint: mintAddress,
      quoteMint: WRAPPED_SOL_MINT,
      liquidityUsd: 100_000,
      fetchedAtMs: nowMs - 1_000,
    },
    quote: {
      inputMint: WRAPPED_SOL_MINT,
      outputMint: mintAddress,
      inputLamports: scorePolicyV1.sizeLamports.quoteProbe,
      outputAmountRaw: 1n,
      fetchedAtMs: nowMs - 1_000,
    },
    holders: { top10Pct: 20, fetchedAtMs: nowMs - 1_000 },
    creator: { holdingPct: 2, fetchedAtMs: nowMs - 1_000 },
    oracle: { mintAddress, deviationBps: 100, fetchedAtMs: nowMs - 1_000 },
  };
}

describe("versioned score policy", () => {
  test("weights total 100 and critical points can reach 70 without optional feeds", () => {
    const { weights } = scorePolicyV1;
    expect(Object.values(weights).reduce((sum, points) => sum + points, 0)).toBe(100);
    const result = scoreSignal({ ...readyInput(), holders: null, creator: null, oracle: null });
    expect(result.scoreVersion).toBe(1);
    expect(result.score).toBe(80);
    expect(result.score).toBeGreaterThanOrEqual(scorePolicyV1.alertThreshold);
    expect(result.canAlert).toBe(true);
    expect(result.optionalDataComplete).toBe(false);
    expect(result.reasons.find((reason) => reason.code === "oracle_none_or_stale")?.points).toBe(0);
  });

  test("only fresh optional evidence adds points", () => {
    const result = scoreSignal({
      ...readyInput(),
      holders: { top10Pct: 20, fetchedAtMs: nowMs - 301_000 },
      creator: null,
      oracle: { mintAddress: "another-mint", deviationBps: 0, fetchedAtMs: nowMs },
    });
    expect(result.score).toBe(80);
    expect(result.canAlert).toBe(true);
    expect(result.optionalDataComplete).toBe(false);
  });

  test("current, complete evidence can score 100", () => {
    const result = scoreSignal(readyInput());
    expect(result.score).toBe(100);
    expect(result.status).toBe("eligible");
    expect(result.optionalDataComplete).toBe(true);
  });

  test("mint authority, freeze authority, and mint mismatch suppress alerts", () => {
    const ready = readyInput();
    if (!ready.mint) throw new Error("Expected mint evidence");
    for (const mint of [
      { ...ready.mint, mintAuthority: "authority" },
      { ...ready.mint, freezeAuthority: "authority" },
      { ...ready.mint, address: "another-mint" },
    ]) {
      const result = scoreSignal({ ...ready, mint });
      expect(result.status).toBe("suppressed");
      expect(result.canAlert).toBe(false);
    }
  });

  test("stale transaction is history-only even with a high score", () => {
    for (const stale of [{ currentSlot: 1_151 }, { observedAtMs: nowMs - 90_001 }]) {
      const result = scoreSignal({ ...readyInput(), ...stale });
      expect(result.status).toBe("history-only");
      expect(result.canAlert).toBe(false);
    }
  });

  test("shallow pool and missing probe quote suppress alerts", () => {
    const ready = readyInput();
    if (!ready.pool || !ready.quote) throw new Error("Expected pool and quote evidence");
    expect(
      scoreSignal({
        ...ready,
        pool: { ...ready.pool, liquidityUsd: 24_999 },
      }).canAlert,
    ).toBe(false);
    expect(
      scoreSignal({
        ...ready,
        quote: { ...ready.quote, inputLamports: 49_999_999n },
      }).canAlert,
    ).toBe(false);
  });

  test("failed or unsupported transaction cannot be promoted by optional points", () => {
    const ready = readyInput();
    expect(scoreSignal({ ...ready, transactionSucceeded: false }).status).toBe("suppressed");
    expect(scoreSignal({ ...ready, supportedBuy: false }).canAlert).toBe(false);
  });

  test("large fresh same-asset oracle deviation suppresses; absent oracle does not", () => {
    const ready = readyInput();
    expect(scoreSignal({ ...ready, oracle: null }).canAlert).toBe(true);
    const result = scoreSignal({
      ...ready,
      oracle: { mintAddress, deviationBps: 1_001, fetchedAtMs: nowMs },
    });
    expect(result.reasons.some((reason) => reason.code === "oracle_deviation_high")).toBe(true);
    expect(result.status).toBe("suppressed");
  });
});

describe("trade limits", () => {
  test("paper permits 0.1 SOL while real is capped at 0.05 SOL", () => {
    expect(checkTradeLimits("paper", 100_000_000n, 25_000, nowMs, nowMs)).toEqual({ allowed: true });
    expect(checkTradeLimits("real", 50_000_000n, 75_000, nowMs, nowMs)).toEqual({ allowed: true });
    expect(checkTradeLimits("real", 50_000_001n, 75_000, nowMs, nowMs)).toEqual({ allowed: false, reason: "size_cap" });
    expect(checkTradeLimits("paper", 100_000_001n, 75_000, nowMs, nowMs)).toEqual({
      allowed: false,
      reason: "size_cap",
    });
  });

  test("real trade requires higher and fresh liquidity", () => {
    expect(checkTradeLimits("unexpected", 50_000_000n, 100_000, nowMs, nowMs)).toEqual({
      allowed: false,
      reason: "invalid_mode",
    });
    expect(checkTradeLimits("paper", 50_000_000n, 30_000, nowMs, nowMs)).toEqual({ allowed: true });
    expect(checkTradeLimits("real", 50_000_000n, 30_000, nowMs, nowMs)).toEqual({
      allowed: false,
      reason: "liquidity_floor",
    });
    expect(checkTradeLimits("real", 50_000_000n, 100_000, nowMs - 15_001, nowMs)).toEqual({
      allowed: false,
      reason: "liquidity_stale",
    });
    expect(checkTradeLimits("real", 0n, 100_000, nowMs, nowMs)).toEqual({ allowed: false, reason: "invalid_size" });
  });
});
