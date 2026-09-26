import type { JupiterService } from "@waffle/jupiter";
import {
  type PaperQuote,
  paperQuoteSchema,
  type ScoreInput,
  scorePolicyV1,
  solanaAddressSchema,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { z } from "zod";
import { decodeMint, decodePool, decodeVault, parseAccounts } from "./accounts.ts";
import { type Evidence, EvidenceCache, EvidenceUnavailable, freshness } from "./evidence-cache.ts";
import type { PythPrices } from "./pyth.ts";
import type { WatcherRpc } from "./rpc.ts";

type Mint = ReturnType<typeof decodeMint>;
type Pool = ReturnType<typeof decodePool> & {
  liquidityUsd: number;
  spotPriceUsd: number;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  slot: number;
};
type OptionalHolder = { mintAddress: string; top10Pct: number };
type OptionalCreator = { mintAddress: string; holdingPct: number };
type Oracle =
  | { source: "none"; reason: string }
  | {
      source: "pyth";
      mintAddress: string;
      feedId: string;
      deviationBps: number;
      fetchedAtMs: number;
      expiresAtMs: number;
    };
export type TokenChecks = {
  mint: Evidence<Mint>;
  pool: Evidence<Pool>;
  quote: Evidence<PaperQuote>;
  holders: Evidence<OptionalHolder>;
  creator: Evidence<OptionalCreator>;
  oracle: Oracle;
};
const optionalSchema = z.object({
  mintAddress: solanaAddressSchema,
  percentage: z.number().finite().min(0).max(100),
  fetchedAtMs: z.number().finite().nonnegative(),
});
export type OptionalTokenData = z.infer<typeof optionalSchema>;
type Dependencies = {
  rpc: Pick<WatcherRpc, "getMultipleAccounts" | "getBlockTime">;
  jupiter: Pick<JupiterService, "getPaperQuote" | "getUsdPrice">;
  pyth: Pick<PythPrices, "get">;
  copySizeLamports?: bigint;
  now?: () => number;
  // Only authoritative owner-aggregated distributions and verified creator attribution belong here.
  getHolders?: (mint: string) => Promise<OptionalTokenData>;
  getCreator?: (mint: string) => Promise<OptionalTokenData>;
};

export class TokenEvidenceCollector {
  private readonly now: () => number;
  private readonly copySize: bigint;
  private readonly mintCache: EvidenceCache<Mint>;
  private readonly poolCache: EvidenceCache<Pool>;
  private readonly quoteCache: EvidenceCache<PaperQuote>;
  private readonly solPriceCache: EvidenceCache<number>;
  private readonly holdersCache: EvidenceCache<OptionalHolder>;
  private readonly creatorCache: EvidenceCache<OptionalCreator>;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now;
    this.copySize = dependencies.copySizeLamports ?? scorePolicyV1.sizeLamports.quoteProbe;
    if (this.copySize < scorePolicyV1.sizeLamports.quoteProbe || this.copySize > scorePolicyV1.sizeLamports.paperMax)
      throw new Error("Evidence probe must be between the score v1 probe size and paper maximum");
    this.mintCache = new EvidenceCache(this.now);
    this.poolCache = new EvidenceCache(this.now);
    this.quoteCache = new EvidenceCache(this.now);
    this.solPriceCache = new EvidenceCache(this.now);
    this.holdersCache = new EvidenceCache(this.now);
    this.creatorCache = new EvidenceCache(this.now);
  }

  async collect(input: { mintAddress: string; poolAddress: string; slot: number }): Promise<TokenChecks> {
    const mint = solanaAddressSchema.parse(input.mintAddress);
    const pool = solanaAddressSchema.parse(input.poolAddress);
    if (!Number.isSafeInteger(input.slot) || input.slot < 0 || mint === WRAPPED_SOL_MINT)
      throw new Error("Invalid evidence request");
    const [mintResult, poolResult, quoteResult, holders, creator, pyth] = await Promise.all([
      this.mintCache.get(mint, async () => {
        const at = this.now();
        const response = parseAccounts(
          await this.dependencies.rpc.getMultipleAccounts([mint], input.slot),
          1,
          input.slot,
        );
        return {
          value: decodeMint(response.value[0], mint),
          fetchedAtMs: at,
          expiresAtMs: at + scorePolicyV1.freshness.mintMs,
        };
      }),
      this.poolCache.get(`${pool}:${mint}`, () => this.loadPool(pool, mint, input.slot)),
      this.quoteCache.get(`${mint}:${this.copySize}`, async () => {
        const quote = paperQuoteSchema.parse(
          await this.dependencies.jupiter.getPaperQuote({
            signalId: crypto.randomUUID(),
            outputMint: mint,
            inputAmountLamports: this.copySize.toString(),
          }),
        );
        if (
          quote.outputMint !== mint ||
          quote.inputMint !== WRAPPED_SOL_MINT ||
          quote.inputAmountLamports !== this.copySize.toString()
        )
          throw new EvidenceUnavailable("quote-mint-or-size-mismatch");
        const fetchedAtMs = Date.parse(quote.fetchedAt);
        return {
          value: quote,
          fetchedAtMs,
          expiresAtMs: Math.min(Date.parse(quote.expiresAt), fetchedAtMs + scorePolicyV1.freshness.quoteMs),
        };
      }),
      this.holdersCache.get(mint, async () => {
        const data = await this.optional(mint, this.dependencies.getHolders, "holder-distribution-unavailable");
        return {
          value: { mintAddress: mint, top10Pct: data.percentage },
          fetchedAtMs: data.fetchedAtMs,
          expiresAtMs: data.fetchedAtMs + scorePolicyV1.freshness.holdersMs,
        };
      }),
      this.creatorCache.get(mint, async () => {
        const data = await this.optional(mint, this.dependencies.getCreator, "creator-attribution-unavailable");
        return {
          value: { mintAddress: mint, holdingPct: data.percentage },
          fetchedAtMs: data.fetchedAtMs,
          expiresAtMs: data.fetchedAtMs + scorePolicyV1.freshness.creatorMs,
        };
      }),
      this.dependencies.pyth.get(mint).catch(() => ({ status: "unknown", reason: "oracle-unavailable" }) as const),
    ]);
    // Other requests may have taken seconds; reevaluate every observation at return time.
    const now = this.now();
    const poolEvidence = freshness(poolResult, now);
    const pythEvidence = freshness(pyth, now);
    let oracle: Oracle = {
      source: "none",
      reason: pythEvidence.status === "unknown" ? pythEvidence.reason : "oracle-stale-or-unpriced",
    };
    if (pythEvidence.status === "fresh" && poolEvidence.status === "fresh" && pythEvidence.value.mintAddress === mint) {
      const deviationBps =
        (Math.abs(poolEvidence.value.spotPriceUsd - pythEvidence.value.priceUsd) / pythEvidence.value.priceUsd) *
        10_000;
      if (Number.isFinite(deviationBps))
        oracle = {
          source: "pyth",
          mintAddress: mint,
          feedId: pythEvidence.value.feedId,
          deviationBps,
          fetchedAtMs: Math.min(pythEvidence.fetchedAtMs, poolEvidence.fetchedAtMs),
          expiresAtMs: Math.min(pythEvidence.expiresAtMs, poolEvidence.expiresAtMs),
        };
    }
    return {
      mint: freshness(mintResult, now),
      pool: poolEvidence,
      quote: freshness(quoteResult, now),
      holders: freshness(holders, now),
      creator: freshness(creator, now),
      oracle,
    };
  }

  private async optional(
    mint: string,
    provider: ((mint: string) => Promise<OptionalTokenData>) | undefined,
    reason: string,
  ) {
    if (!provider) throw new EvidenceUnavailable(reason);
    const data = optionalSchema.parse(await provider(mint));
    if (data.mintAddress !== mint) throw new EvidenceUnavailable("optional-mint-mismatch");
    return data;
  }

  private async loadPool(address: string, mint: string, minSlot: number) {
    const at = this.now();
    const discovery = parseAccounts(await this.dependencies.rpc.getMultipleAccounts([address], minSlot), 1, minSlot);
    const pool = decodePool(discovery.value[0], address, mint);
    const snapshot = parseAccounts(
      await this.dependencies.rpc.getMultipleAccounts(
        [address, mint, pool.baseVault, pool.quoteVault],
        discovery.context.slot,
      ),
      4,
      discovery.context.slot,
    );
    const verified = decodePool(snapshot.value[0], address, mint);
    if (verified.baseVault !== pool.baseVault || verified.quoteVault !== pool.quoteVault)
      throw new EvidenceUnavailable("pool-changed");
    const token = decodeMint(snapshot.value[1], mint);
    const base = decodeVault(snapshot.value[2], mint, address);
    const quote = decodeVault(snapshot.value[3], WRAPPED_SOL_MINT, address);
    if (base === 0n || quote === 0n) throw new EvidenceUnavailable("pool-empty");
    const sol = await this.solPriceCache.get(WRAPPED_SOL_MINT, async () => {
      const requestedAt = this.now();
      const price = await this.dependencies.jupiter.getUsdPrice(WRAPPED_SOL_MINT);
      if (price.decimals !== 9 || !Number.isFinite(price.usdPrice) || price.usdPrice <= 0)
        throw new EvidenceUnavailable("invalid-sol-price");
      const publishedAt = (await this.dependencies.rpc.getBlockTime(price.blockId)) * 1000;
      if (publishedAt > this.now()) throw new EvidenceUnavailable("future-sol-price");
      const fetchedAtMs = Math.min(requestedAt, publishedAt);
      return { value: price.usdPrice, fetchedAtMs, expiresAtMs: fetchedAtMs + scorePolicyV1.freshness.oracleMs };
    });
    if (sol.status !== "fresh") throw new EvidenceUnavailable("sol-price-unavailable-or-stale");
    const quoteSol = Number(quote) / 1e9;
    const liquidityUsd = 2 * quoteSol * sol.value;
    const spotPriceUsd = (quoteSol / (Number(base) / 10 ** token.decimals)) * sol.value;
    if (!Number.isFinite(liquidityUsd) || !Number.isFinite(spotPriceUsd) || spotPriceUsd <= 0)
      throw new EvidenceUnavailable("invalid-pool-valuation");
    return {
      value: {
        ...verified,
        liquidityUsd,
        spotPriceUsd,
        baseReserveRaw: base.toString(),
        quoteReserveRaw: quote.toString(),
        slot: snapshot.context.slot,
      },
      fetchedAtMs: Math.min(at, sol.fetchedAtMs),
      expiresAtMs: Math.min(at + scorePolicyV1.freshness.poolMs, sol.expiresAtMs),
    };
  }
}

/** Converts usable observations to the existing scorer contract; unavailable/stale evidence earns no points. */
export function toScoreEvidence(
  checks: TokenChecks,
  nowMs = Date.now(),
): Pick<ScoreInput, "mint" | "pool" | "quote" | "holders" | "creator" | "oracle"> {
  const mint = freshness(checks.mint, nowMs);
  const pool = freshness(checks.pool, nowMs);
  const quote = freshness(checks.quote, nowMs);
  const holders = freshness(checks.holders, nowMs);
  const creator = freshness(checks.creator, nowMs);
  return {
    mint:
      mint.status === "fresh"
        ? {
            address: mint.value.address,
            tokenProgramId: mint.value.tokenProgramId,
            mintAuthority: mint.value.mintAuthority,
            freezeAuthority: mint.value.freezeAuthority,
            fetchedAtMs: mint.fetchedAtMs,
          }
        : null,
    pool:
      pool.status === "fresh"
        ? {
            baseMint: pool.value.baseMint,
            quoteMint: pool.value.quoteMint,
            liquidityUsd: pool.value.liquidityUsd,
            fetchedAtMs: pool.fetchedAtMs,
          }
        : null,
    quote:
      quote.status === "fresh"
        ? {
            inputMint: quote.value.inputMint,
            outputMint: quote.value.outputMint,
            inputLamports: BigInt(quote.value.inputAmountLamports),
            outputAmountRaw: BigInt(quote.value.outputAmountRaw),
            fetchedAtMs: quote.fetchedAtMs,
          }
        : null,
    holders: holders.status === "fresh" ? { top10Pct: holders.value.top10Pct, fetchedAtMs: holders.fetchedAtMs } : null,
    creator:
      creator.status === "fresh" ? { holdingPct: creator.value.holdingPct, fetchedAtMs: creator.fetchedAtMs } : null,
    oracle:
      checks.oracle.source === "pyth" && checks.oracle.fetchedAtMs <= nowMs && nowMs < checks.oracle.expiresAtMs
        ? {
            mintAddress: checks.oracle.mintAddress,
            deviationBps: checks.oracle.deviationBps,
            fetchedAtMs: checks.oracle.fetchedAtMs,
          }
        : null,
  };
}
