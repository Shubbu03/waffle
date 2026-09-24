export type ScorePolicy = {
  readonly version: number;
  readonly alertThreshold: number;
  readonly freshness: {
    readonly signalSlots: number;
    readonly signalMs: number;
    readonly mintMs: number;
    readonly poolMs: number;
    readonly quoteMs: number;
    readonly holdersMs: number;
    readonly creatorMs: number;
    readonly oracleMs: number;
  };
  readonly liquidityUsd: {
    readonly signalAndPaper: number;
    readonly real: number;
  };
  readonly sizeLamports: {
    readonly paperMax: bigint;
    readonly realMax: bigint;
    readonly quoteProbe: bigint;
  };
  readonly weights: {
    readonly supportedBuy: number;
    readonly freshness: number;
    readonly mint: number;
    readonly pool: number;
    readonly quote: number;
    readonly holders: number;
    readonly creator: number;
    readonly oracle: number;
  };
  readonly optional: {
    readonly maxTop10HolderPct: number;
    readonly maxCreatorHoldingPct: number;
    readonly maxOracleDeviationBpsForPoints: number;
    readonly suppressOracleDeviationBps: number;
  };
};

/** Policy changes require a new version so persisted scores remain interpretable. */
export const scorePolicyV1 = {
  version: 1,
  alertThreshold: 70,
  freshness: {
    signalSlots: 150,
    signalMs: 90_000,
    mintMs: 60_000,
    poolMs: 15_000,
    quoteMs: 10_000,
    holdersMs: 300_000,
    creatorMs: 300_000,
    oracleMs: 10_000,
  },
  liquidityUsd: {
    signalAndPaper: 25_000,
    real: 75_000,
  },
  sizeLamports: {
    paperMax: 100_000_000n, // 0.1 SOL
    realMax: 50_000_000n, // 0.05 SOL
    quoteProbe: 50_000_000n,
  },
  weights: {
    supportedBuy: 20,
    freshness: 15,
    mint: 20,
    pool: 15,
    quote: 10,
    holders: 8,
    creator: 7,
    oracle: 5,
  },
  optional: {
    maxTop10HolderPct: 30,
    maxCreatorHoldingPct: 5,
    maxOracleDeviationBpsForPoints: 300,
    suppressOracleDeviationBps: 1_000,
  },
} as const satisfies ScorePolicy;

export { SPL_TOKEN_PROGRAM_ID, WRAPPED_SOL_MINT } from "../program-ids.ts";
