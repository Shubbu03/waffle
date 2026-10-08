import {
  PUMP_SWAP_PROGRAM_ID,
  type SignalDetail,
  SPL_TOKEN_PROGRAM_ID,
  type TradeAssessment,
  type TradeMode,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";

export function assessmentFixture(signal: SignalDetail, mode: TradeMode, size: string, now: number): TradeAssessment {
  return {
    policyVersion: 1,
    signalId: signal.id,
    mode,
    inputAmountLamports: size,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10_000).toISOString(),
    mint: {
      address: signal.mintAddress,
      tokenProgramId: SPL_TOKEN_PROGRAM_ID,
      decimals: 6,
      mintAuthority: null,
      freezeAuthority: null,
      fetchedAt: new Date(now).toISOString(),
    },
    pool: {
      address: PUMP_SWAP_PROGRAM_ID,
      baseMint: signal.mintAddress,
      quoteMint: WRAPPED_SOL_MINT,
      liquidityUsd: 100_000,
      fetchedAt: new Date(now).toISOString(),
    },
    oracle: { source: "none" },
  };
}
