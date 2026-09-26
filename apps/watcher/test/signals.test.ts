import { describe, expect, test } from "bun:test";
import { type ScoredSignal, SPL_TOKEN_PROGRAM_ID, scoredSignalSchema, WRAPPED_SOL_MINT } from "@waffle/shared";
import { classifyPumpSwapBuy } from "../src/classify.ts";
import type { TokenChecks } from "../src/evidence.ts";
import type { Evidence } from "../src/evidence-cache.ts";
import { SignalPipeline } from "../src/signals.ts";
import type { WatcherEvent } from "../src/watcher.ts";

const fixture = await Bun.file(new URL("../../../tests/fixtures/pumpswap-buy.json", import.meta.url)).json();
const signature: string = fixture.transaction.signatures[0];
const wallet: string = fixture.transaction.message.accountKeys.find((key: { signer: boolean }) => key.signer).pubkey;
const classified = classifyPumpSwapBuy(fixture, wallet, signature);
if (classified.status !== "buy") throw new Error("Expected buy fixture");
const buy = classified.buy;
const start = 1_800_000_000_000;
const iso = (value: number) => new Date(value).toISOString();
const fresh = <T>(value: T, ttl = 10_000): Evidence<T> => ({
  status: "fresh",
  value,
  fetchedAtMs: start,
  expiresAtMs: start + ttl,
});
function checks(): TokenChecks {
  return {
    mint: fresh(
      {
        address: buy.mintAddress,
        tokenProgramId: SPL_TOKEN_PROGRAM_ID,
        mintAuthority: null,
        freezeAuthority: null,
        supplyRaw: "1000000",
        decimals: 6,
      },
      60_000,
    ),
    pool: fresh({
      address: buy.poolAddress,
      baseMint: buy.mintAddress,
      quoteMint: WRAPPED_SOL_MINT,
      baseVault: wallet,
      quoteVault: wallet,
      liquidityUsd: 100_000,
      spotPriceUsd: 1,
      baseReserveRaw: "1000000",
      quoteReserveRaw: "1000000000",
      slot: buy.slot,
    }),
    quote: fresh({
      id: crypto.randomUUID(),
      signalId: crypto.randomUUID(),
      kind: "paper",
      inputMint: WRAPPED_SOL_MINT,
      outputMint: buy.mintAddress,
      inputAmountLamports: "50000000",
      outputAmountRaw: "9007199254740993",
      minOutputAmountRaw: "9007199254740990",
      requestId: "probe",
      router: "metis",
      feeLamports: "0",
      fees: {
        totalBps: 0,
        mint: null,
        platform: null,
        signatureLamports: "0",
        prioritizationLamports: "0",
        rentLamports: "0",
      },
      slippageBps: 200,
      priceImpactBps: 0,
      priceImpactPct: 0,
      fetchedAt: iso(start),
      expiresAt: iso(start + 10_000),
      providerQuoteId: null,
    }),
    holders: { status: "unknown", reason: "holder-distribution-unavailable" },
    creator: { status: "unknown", reason: "creator-attribution-unavailable" },
    oracle: { source: "none", reason: "no-same-asset-feed" },
  };
}
function harness() {
  let now = start;
  let currentSlot = buy.slot + 1;
  let stale = false;
  let collectCalls = 0;
  let beforeWrite = () => {};
  let writeError = false;
  let duplicate = false;
  let collected = checks();
  const saved: ScoredSignal[] = [];
  const event: WatcherEvent = {
    outcome: {
      status: "buy",
      wallet,
      signature,
      buy,
      transaction: { ...structuredClone(fixture), blockTime: start / 1000 },
    },
    source: "provisional",
    stale: false,
    observedAtMs: start,
  };
  const pipeline = new SignalPipeline({
    now: () => now,
    context: () => ({ currentSlot, stale }),
    evidence: {
      async collect() {
        collectCalls++;
        return collected;
      },
    },
    database: {
      async storeSignal(address, prepare) {
        expect(address).toBe(wallet);
        beforeWrite();
        if (writeError) throw new Error("write failed");
        const signal = scoredSignalSchema.parse(JSON.parse(JSON.stringify(prepare())));
        if (duplicate) return { status: "duplicate" };
        saved.push(signal);
        return { status: "inserted", signalId: crypto.randomUUID(), eventId: "1" };
      },
    },
  });
  return {
    pipeline,
    event,
    saved,
    get collectCalls() {
      return collectCalls;
    },
    set time(value: number) {
      now = value;
    },
    set slot(value: number) {
      currentSlot = value;
    },
    set stale(value: boolean) {
      stale = value;
    },
    get checks() {
      return collected;
    },
    set checks(value: TokenChecks) {
      collected = value;
    },
    set beforeWrite(value: () => void) {
      beforeWrite = value;
    },
    set writeError(value: boolean) {
      writeError = value;
    },
    set duplicate(value: boolean) {
      duplicate = value;
    },
  };
}
function saved(h: ReturnType<typeof harness>) {
  const signal = h.saved[0];
  if (!signal) throw new Error("Expected saved signal");
  return signal;
}

describe("signal pipeline", () => {
  test("shutdown drains already accepted enrichment before the database is closed", async () => {
    let finish: ((value: TokenChecks) => void) | undefined;
    let wrote = false;
    const h = harness();
    const pipeline = new SignalPipeline({
      now: () => start,
      context: () => ({ currentSlot: buy.slot, stale: true }),
      evidence: {
        collect: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      database: {
        async storeSignal(_wallet, prepare) {
          prepare();
          wrote = true;
          return { status: "duplicate" };
        },
      },
    });
    const work = pipeline.handle(h.event);
    let closed = false;
    const closing = pipeline.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(pipeline.handle(h.event)).rejects.toThrow("Signal pipeline stopped");
    finish?.(checks());
    await work;
    await closing;
    expect(wrote).toBe(true);
  });

  test("persists v1 reasons, source slot and exact amounts; optional/oracle absence earns zero", async () => {
    const h = harness();
    expect((await h.pipeline.handle(h.event))?.status).toBe("inserted");
    const signal = saved(h);
    expect(signal).toMatchObject({
      score: 80,
      scoreVersion: 1,
      status: "eligible",
      dataStatus: "partial",
      slot: buy.slot,
    });
    expect(signal.reasons.reduce((sum, reason) => sum + reason.points, 0)).toBe(80);
    expect(signal.reasons.slice(-3).map((reason) => reason.points)).toEqual([0, 0, 0]);
    expect(signal.snapshot.quote?.outputAmountRaw).toBe("9007199254740993");
    expect(signal.snapshot.assessment?.evidence.oracle).toEqual({
      status: "unknown",
      expiresAt: null,
      reason: "no-same-asset-feed",
    });
    expect(signal.snapshot.assessment?.transactionAt).toBe(iso(start));
  });

  test("mint authority suppresses while retaining unsafe evidence", async () => {
    const h = harness();
    if (h.checks.mint.status === "unknown") throw new Error("Expected mint");
    h.checks.mint.value.mintAuthority = wallet;
    await h.pipeline.handle(h.event);
    expect(saved(h)).toMatchObject({ status: "suppressed", score: 60 });
    expect(saved(h).snapshot.mint?.mintAuthority).toBe(wallet);
  });

  test("fresh complete evidence scores 100; excessive same-asset oracle deviation suppresses", async () => {
    const h = harness();
    h.checks.holders = fresh({ mintAddress: buy.mintAddress, top10Pct: 20 });
    h.checks.creator = fresh({ mintAddress: buy.mintAddress, holdingPct: 2 });
    h.checks.oracle = {
      source: "pyth",
      mintAddress: buy.mintAddress,
      feedId: "ab".repeat(32),
      deviationBps: 100,
      fetchedAtMs: start,
      expiresAtMs: start + 1000,
    };
    await h.pipeline.handle(h.event);
    expect(saved(h)).toMatchObject({ score: 100, status: "eligible", dataStatus: "complete" });
    h.checks.oracle.deviationBps = 1001;
    h.saved.length = 0;
    await h.pipeline.handle(h.event);
    expect(saved(h)).toMatchObject({ score: 95, status: "suppressed" });
  });

  test("stale slots, stream outages and delayed observation cannot alert", async () => {
    for (const mode of ["slot", "event", "stream", "observation"] as const) {
      const h = harness();
      if (mode === "slot") h.slot = buy.slot + 151;
      if (mode === "event") h.event.stale = true;
      if (mode === "stream")
        h.beforeWrite = () => {
          h.stale = true;
        };
      if (mode === "observation") h.event.observedAtMs = start - 90_001;
      await h.pipeline.handle(h.event);
      expect(saved(h)).toMatchObject({ status: "history-only", dataStatus: "stale", score: 65 });
    }
  });

  test("recently fetched backfill with old, missing or future block time stays history-only", async () => {
    for (const blockTime of [start / 1000 - 91, null, start / 1000 + 10]) {
      const h = harness();
      h.event.source = "backfill";
      h.event.outcome = { ...h.event.outcome, transaction: { ...fixture, blockTime } } as WatcherEvent["outcome"];
      await h.pipeline.handle(h.event);
      expect(saved(h)).toMatchObject({ status: "history-only", dataStatus: "stale" });
    }
  });

  test("critical evidence that expires during write queuing suppresses; optional expiry only loses points", async () => {
    const h = harness();
    h.beforeWrite = () => {
      h.time = start + 10_000;
    };
    await h.pipeline.handle(h.event);
    expect(saved(h)).toMatchObject({ status: "suppressed", dataStatus: "stale" });
    expect(saved(h).snapshot.quote).not.toBeNull();
    expect(saved(h).snapshot.assessment?.evidence.quote.status).toBe("stale");
    const optional = harness();
    optional.checks.holders = fresh({ mintAddress: buy.mintAddress, top10Pct: 20 }, 1000);
    optional.time = start + 1000;
    await optional.pipeline.handle(optional.event);
    expect(saved(optional)).toMatchObject({ score: 80, status: "eligible", dataStatus: "partial" });
  });

  test("unknown critical checks suppress with an explicit reason", async () => {
    const h = harness();
    h.checks.pool = { status: "unknown", reason: "sol-price-unavailable-or-stale" };
    await h.pipeline.handle(h.event);
    expect(saved(h)).toMatchObject({ status: "suppressed", dataStatus: "unknown" });
    expect(saved(h).snapshot.assessment?.evidence.pool.reason).toBe("sol-price-unavailable-or-stale");
  });

  test("failed transactions and ignored events never reach enrichment or persistence", async () => {
    const h = harness();
    h.event.outcome = { status: "ignored", wallet, signature, reason: "sell" };
    expect(await h.pipeline.handle(h.event)).toBeNull();
    h.event.outcome = {
      status: "buy",
      wallet,
      signature,
      buy,
      transaction: { ...fixture, meta: { ...fixture.meta, err: { InstructionError: [0, "Custom"] } } },
    };
    expect(await h.pipeline.handle(h.event)).toBeNull();
    expect(h.collectCalls).toBe(0);
    expect(h.saved).toHaveLength(0);
  });

  test("write errors propagate for watcher retry; duplicates are not republished", async () => {
    const h = harness();
    h.writeError = true;
    await expect(h.pipeline.handle(h.event)).rejects.toThrow("write failed");
    h.writeError = false;
    h.duplicate = true;
    expect(await h.pipeline.handle(h.event)).toEqual({ status: "duplicate" });
    expect(h.saved).toHaveLength(0);
  });
});
