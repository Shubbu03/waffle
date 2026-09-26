import type { SignalWriteResult } from "@waffle/db";
import { type ScoredSignal, scoredSignalSchema, scoreSignal } from "@waffle/shared";
import { classifyPumpSwapBuy } from "./classify.ts";
import { type TokenChecks, type TokenEvidenceCollector, toScoreEvidence } from "./evidence.ts";
import { type Evidence, freshness } from "./evidence-cache.ts";
import type { WatcherEvent } from "./watcher.ts";

type Dependencies = {
  evidence: Pick<TokenEvidenceCollector, "collect">;
  database: { storeSignal(walletAddress: string, prepare: () => ScoredSignal): Promise<SignalWriteResult> };
  context: (wallet: string) => { currentSlot: number; stale: boolean };
  now?: () => number;
};
const iso = (ms: number) => new Date(ms).toISOString();

function state<T>(check: Evidence<T>, now: number) {
  const current = freshness(check, now);
  return current.status === "unknown"
    ? { status: current.status, expiresAt: null, reason: current.reason }
    : { status: current.status, expiresAt: iso(current.expiresAtMs), reason: null };
}

function snapshot(checks: TokenChecks, now: number) {
  const { mint, pool, quote, holders, creator, oracle } = checks;
  const oracleState =
    oracle.source === "none"
      ? { status: "unknown" as const, expiresAt: null, reason: oracle.reason }
      : state(
          { status: "fresh", value: oracle, fetchedAtMs: oracle.fetchedAtMs, expiresAtMs: oracle.expiresAtMs },
          now,
        );
  return {
    evidence: {
      mint: state(mint, now),
      pool: state(pool, now),
      quote: state(quote, now),
      holders: state(holders, now),
      creator: state(creator, now),
      oracle: oracleState,
    },
    values: {
      mint:
        mint.status === "unknown"
          ? null
          : {
              address: mint.value.address,
              tokenProgramId: mint.value.tokenProgramId,
              mintAuthority: mint.value.mintAuthority,
              freezeAuthority: mint.value.freezeAuthority,
              fetchedAt: iso(mint.fetchedAtMs),
            },
      pool:
        pool.status === "unknown"
          ? null
          : {
              baseMint: pool.value.baseMint,
              quoteMint: pool.value.quoteMint,
              liquidityUsd: pool.value.liquidityUsd,
              fetchedAt: iso(pool.fetchedAtMs),
            },
      quote:
        quote.status === "unknown"
          ? null
          : {
              inputMint: quote.value.inputMint,
              outputMint: quote.value.outputMint,
              inputLamports: quote.value.inputAmountLamports,
              outputAmountRaw: quote.value.outputAmountRaw,
              fetchedAt: iso(quote.fetchedAtMs),
            },
      holders:
        holders.status === "unknown" ? null : { top10Pct: holders.value.top10Pct, fetchedAt: iso(holders.fetchedAtMs) },
      creator:
        creator.status === "unknown"
          ? null
          : { holdingPct: creator.value.holdingPct, fetchedAt: iso(creator.fetchedAtMs) },
      oracle:
        oracle.source === "none"
          ? null
          : {
              mintAddress: oracle.mintAddress,
              deviationBps: oracle.deviationBps,
              fetchedAt: iso(oracle.fetchedAtMs),
            },
    },
  };
}

/** Enrich outside the write transaction, then assess freshness at the serialized persistence boundary. */
export class SignalPipeline {
  private readonly pending = new Set<Promise<SignalWriteResult | null>>();
  private readonly now: () => number;
  private stopped = false;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async handle(event: WatcherEvent): Promise<SignalWriteResult | null> {
    if (this.stopped) throw new Error("Signal pipeline stopped");
    const work = this.process(event);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.pending);
  }

  private async process(event: WatcherEvent): Promise<SignalWriteResult | null> {
    if (event.outcome.status !== "buy") return null;
    const { transaction, wallet, signature } = event.outcome;
    // Revalidate the raw transaction at the write pipeline boundary, including meta.err and identity.
    const classified = classifyPumpSwapBuy(transaction, wallet, signature);
    if (classified.status !== "buy") return null;
    const { buy } = classified;
    const blockTime =
      typeof transaction === "object" && transaction !== null && "blockTime" in transaction
        ? transaction.blockTime
        : null;
    const checks = await this.dependencies.evidence.collect({
      mintAddress: buy.mintAddress,
      poolAddress: buy.poolAddress,
      slot: buy.slot,
    });
    return this.dependencies.database.storeSignal(wallet, () => {
      const now = this.now();
      const context = this.dependencies.context(wallet);
      const streamStale = event.stale || context.stale;
      const transactionAtMs =
        typeof blockTime === "number" && Number.isSafeInteger(blockTime) && blockTime >= 0 && blockTime * 1000 <= now
          ? blockTime * 1000
          : null;
      const result = scoreSignal({
        ...toScoreEvidence(checks, now),
        mintAddress: buy.mintAddress,
        supportedBuy: true,
        transactionSucceeded: true,
        transactionSlot: buy.slot,
        observedAtMs: event.observedAtMs,
        currentSlot: context.currentSlot,
        nowMs: now,
        streamStale,
        transactionAtMs,
      });
      const saved = snapshot(checks, now);
      const critical = [saved.evidence.mint, saved.evidence.pool, saved.evidence.quote];
      const dataStatus =
        result.reasons.some((reason) => reason.code === "stale_signal") ||
        critical.some((check) => check.status === "stale")
          ? "stale"
          : critical.some((check) => check.status === "unknown")
            ? "unknown"
            : Object.values(saved.evidence).some((check) => check.status !== "fresh")
              ? "partial"
              : "complete";
      return scoredSignalSchema.parse({
        signature,
        walletAddress: wallet,
        mintAddress: buy.mintAddress,
        sourceProgramId: buy.sourceProgramId,
        slot: buy.slot,
        observedAt: iso(event.observedAtMs),
        scoreVersion: result.scoreVersion,
        score: result.score,
        status: result.status,
        dataStatus,
        reasons: result.reasons,
        snapshot: {
          ...saved.values,
          transactionSlot: buy.slot,
          currentSlot: context.currentSlot,
          assessment: {
            scoredAt: iso(now),
            transactionAt: transactionAtMs === null ? null : iso(transactionAtMs),
            source: event.source,
            streamStale,
            evidence: saved.evidence,
          },
        },
      });
    });
  }
}
