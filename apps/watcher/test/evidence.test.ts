import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  type PaperQuote,
  PUMP_SWAP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  TOKEN_2022_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { parseWatcherEnv } from "../src/config.ts";
import { type OptionalTokenData, TokenEvidenceCollector, toScoreEvidence } from "../src/evidence.ts";
import { type Evidence, EvidenceCache } from "../src/evidence-cache.ts";
import { type PythPrice, PythPrices } from "../src/pyth.ts";

const address = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const mint = address(7);
const creator = address(8);
const baseVault = address(9);
const quoteVault = address(10);
const [poolKey, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("pool"),
    Buffer.from([0, 0]),
    new PublicKey(creator).toBuffer(),
    new PublicKey(mint).toBuffer(),
    new PublicKey(WRAPPED_SOL_MINT).toBuffer(),
  ],
  new PublicKey(PUMP_SWAP_PROGRAM_ID),
);
const pool = poolKey.toBase58();
const feedId = "ab".repeat(32);
const start = 1_800_000_000_000;
const bytesKey = (key: string) => new PublicKey(key).toBuffer();
function mintBytes(): Buffer {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(1_000_000_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  return data;
}
function poolBytes(): Buffer {
  const data = Buffer.alloc(271);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(data);
  data[8] = bump;
  bytesKey(creator).copy(data, 11);
  bytesKey(mint).copy(data, 43);
  bytesKey(WRAPPED_SOL_MINT).copy(data, 75);
  bytesKey(address(11)).copy(data, 107);
  bytesKey(baseVault).copy(data, 139);
  bytesKey(quoteVault).copy(data, 171);
  return data;
}
function vaultBytes(mint: string, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  bytesKey(mint).copy(data);
  bytesKey(pool).copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}
function account(data: Buffer, owner = SPL_TOKEN_PROGRAM_ID) {
  return { owner, executable: false, data: [data.toString("base64"), "base64"] };
}
function quote(now: number, outputMint = mint, size = "50000000"): PaperQuote {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    signalId: "00000000-0000-4000-8000-000000000002",
    kind: "paper",
    inputMint: WRAPPED_SOL_MINT,
    outputMint,
    inputAmountLamports: size,
    outputAmountRaw: "500000",
    minOutputAmountRaw: "490000",
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
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10_000).toISOString(),
    providerQuoteId: null,
  };
}
function harness(
  options: {
    size?: bigint;
    holders?: (mint: string) => Promise<OptionalTokenData>;
    creator?: (mint: string) => Promise<OptionalTokenData>;
  } = {},
) {
  let now = start;
  let fail = false;
  let quoteOverride: PaperQuote | undefined;
  let priceAgeMs = 0;
  let contextSlot = 100;
  let oracle: Evidence<PythPrice> = { status: "unknown", reason: "no-same-asset-feed" };
  const accounts = new Map([
    [mint, account(mintBytes())],
    [pool, account(poolBytes(), PUMP_SWAP_PROGRAM_ID)],
    [baseVault, account(vaultBytes(mint, 1_000_000_000n))],
    [quoteVault, account(vaultBytes(WRAPPED_SOL_MINT, 100_000_000_000n))],
  ]);
  const calls = { accounts: [] as string[][], quotes: [] as unknown[], prices: 0, blocks: 0 };
  const collector = new TokenEvidenceCollector({
    now: () => now,
    ...(options.size ? { copySizeLamports: options.size } : {}),
    ...(options.holders ? { getHolders: options.holders } : {}),
    ...(options.creator ? { getCreator: options.creator } : {}),
    rpc: {
      async getMultipleAccounts(addresses) {
        calls.accounts.push([...addresses]);
        if (fail) throw new Error("secret-rpc-url");
        return { context: { slot: contextSlot }, value: addresses.map((key) => accounts.get(key) ?? null) };
      },
      async getBlockTime() {
        calls.blocks++;
        return (now - priceAgeMs) / 1000;
      },
    },
    jupiter: {
      async getPaperQuote(input) {
        calls.quotes.push(input);
        if (fail) throw new Error("secret-api-key");
        const request = input as { outputMint: string; inputAmountLamports: string };
        return quoteOverride ?? quote(now, request.outputMint, request.inputAmountLamports);
      },
      async getUsdPrice() {
        calls.prices++;
        if (fail) throw new Error("unavailable");
        return { usdPrice: 150, blockId: 100, decimals: 9 };
      },
    },
    pyth: {
      async get() {
        return oracle;
      },
    },
  });
  return {
    collector,
    accounts,
    calls,
    collect: () => collector.collect({ mintAddress: mint, poolAddress: pool, slot: 100 }),
    advance(ms: number) {
      now += ms;
    },
    fail(value = true) {
      fail = value;
    },
    quote(value: PaperQuote) {
      quoteOverride = value;
    },
    priceAge(ms: number) {
      priceAgeMs = ms;
    },
    slot(slot: number) {
      contextSlot = slot;
    },
    oracle(value: Evidence<PythPrice>) {
      oracle = value;
    },
  };
}

describe("token and pool evidence", () => {
  test("reads exact mint and verified vaults, values reserves, and probes the configured size", async () => {
    const h = harness({ size: 75_000_000n });
    const result = await h.collect();
    expect(result.mint).toMatchObject({
      status: "fresh",
      value: { address: mint, mintAuthority: null, freezeAuthority: null },
    });
    expect(result.pool).toMatchObject({
      status: "fresh",
      value: { address: pool, baseMint: mint, liquidityUsd: 30_000, spotPriceUsd: 15 },
    });
    expect(h.calls.accounts).toContainEqual([pool, mint, baseVault, quoteVault]);
    expect(h.calls.quotes[0]).toMatchObject({ outputMint: mint, inputAmountLamports: "75000000" });
    expect(result.holders).toEqual({ status: "unknown", reason: "holder-distribution-unavailable" });
    expect(result.creator).toEqual({ status: "unknown", reason: "creator-attribution-unavailable" });
    expect(result.oracle).toEqual({ source: "none", reason: "no-same-asset-feed" });
    expect(
      scoreSignal({
        mintAddress: mint,
        supportedBuy: true,
        transactionSucceeded: true,
        transactionSlot: 100,
        currentSlot: 100,
        observedAtMs: start,
        nowMs: start,
        ...toScoreEvidence(result, start),
      }),
    ).toMatchObject({ score: 80, canAlert: true });
  });

  test("shares pending loads and caches each resource without renewing timestamps", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.collect(), h.collect()]);
    expect(a).toEqual(b);
    expect(h.calls.accounts).toHaveLength(3);
    expect(h.calls.quotes).toHaveLength(1);
    expect(h.calls.prices).toBe(1);
    h.advance(5000);
    const cached = await h.collect();
    expect(cached).toEqual(a);
    if (cached.mint.status !== "unknown") cached.mint.value.mintAuthority = creator;
    expect((await h.collect()).mint).toMatchObject({ value: { mintAuthority: null } });
    h.advance(5000);
    const refreshed = await h.collect();
    expect(h.calls.accounts).toHaveLength(5);
    expect(h.calls.quotes).toHaveLength(2);
    expect(refreshed.mint).toEqual(a.mint);
    expect(refreshed.pool).toMatchObject({ fetchedAtMs: start + 10_000 });
  });

  test("failed refresh keeps old timestamps and stale data cannot enter the scorer", async () => {
    const h = harness();
    const original = await h.collect();
    h.advance(61_000);
    h.fail();
    const stale = await h.collect();
    expect(stale.mint).toMatchObject({ status: "stale", fetchedAtMs: start });
    expect(stale.pool).toMatchObject({ status: "stale", fetchedAtMs: start });
    expect(stale.quote).toMatchObject({ status: "stale", fetchedAtMs: start });
    expect(toScoreEvidence(stale, start + 61_000)).toEqual({
      mint: null,
      pool: null,
      quote: null,
      holders: null,
      creator: null,
      oracle: null,
    });
    expect(toScoreEvidence(original, start + 61_000).quote).toBeNull();
    expect(JSON.stringify(stale)).not.toContain("secret");
    h.fail(false);
    h.advance(2000);
    expect((await h.collect()).mint.status).toBe("fresh");
  });

  test("authority-bearing mints remain visible and fail the existing policy", async () => {
    const h = harness();
    const data = mintBytes();
    data.writeUInt32LE(1, 0);
    bytesKey(creator).copy(data, 4);
    h.accounts.set(mint, account(data));
    const result = await h.collect();
    expect(result.mint).toMatchObject({ status: "fresh", value: { mintAuthority: creator } });
    expect(
      scoreSignal({
        mintAddress: mint,
        supportedBuy: true,
        transactionSucceeded: true,
        transactionSlot: 100,
        currentSlot: 100,
        observedAtMs: start,
        nowMs: start,
        ...toScoreEvidence(result, start),
      }).canAlert,
    ).toBe(false);
  });

  test("rejects Token-2022, malformed mint options and uninitialized mints", async () => {
    const variants = [account(mintBytes(), TOKEN_2022_PROGRAM_ID), account(Buffer.alloc(82))];
    const malformed = mintBytes();
    malformed.writeUInt32LE(2, 0);
    variants.push(account(malformed));
    for (const value of variants) {
      const h = harness();
      h.accounts.set(mint, value);
      expect((await h.collect()).mint.status).toBe("unknown");
    }
  });

  test("rejects wrong pool mint, owner, discriminator, PDA and virtual reserves", async () => {
    const wrongMint = poolBytes();
    bytesKey(address(12)).copy(wrongMint, 43);
    const wrongDiscriminator = poolBytes();
    wrongDiscriminator[0] = 0;
    const wrongPda = poolBytes();
    wrongPda[9] = 1;
    const virtual = poolBytes();
    virtual[245] = 1;
    for (const value of [
      account(wrongMint, PUMP_SWAP_PROGRAM_ID),
      account(poolBytes()),
      account(wrongDiscriminator, PUMP_SWAP_PROGRAM_ID),
      account(wrongPda, PUMP_SWAP_PROGRAM_ID),
      account(virtual, PUMP_SWAP_PROGRAM_ID),
    ]) {
      const h = harness();
      h.accounts.set(pool, value);
      expect((await h.collect()).pool.status).toBe("unknown");
      expect(h.calls.prices).toBe(0);
    }
  });

  test("rejects wrong-mint, wrong-authority, frozen, delegated, and empty vaults", async () => {
    const wrongOwner = vaultBytes(mint, 1n);
    bytesKey(creator).copy(wrongOwner, 32);
    const frozen = vaultBytes(mint, 1n);
    frozen[108] = 2;
    const delegated = vaultBytes(mint, 1n);
    delegated.writeUInt32LE(1, 72);
    bytesKey(creator).copy(delegated, 76);
    for (const data of [vaultBytes(address(12), 1n), wrongOwner, frozen, delegated, vaultBytes(mint, 0n)]) {
      const h = harness();
      h.accounts.set(baseVault, account(data));
      expect((await h.collect()).pool.status).toBe("unknown");
    }
  });

  test("old RPC contexts and old SOL prices cannot produce fresh liquidity", async () => {
    const h = harness();
    h.slot(99);
    const behind = await h.collect();
    expect(behind.pool.status).toBe("unknown");
    expect(behind.mint.status).toBe("unknown");
    const old = harness();
    old.priceAge(11_000);
    expect((await old.collect()).pool.status).toBe("unknown");
    const future = harness();
    future.priceAge(-1000);
    expect((await future.collect()).pool.status).toBe("unknown");
  });

  test("rejects mismatched quote mint or size and observes provider expiry", async () => {
    for (const value of [quote(start, address(12)), quote(start, mint, "10000000")]) {
      const h = harness();
      h.quote(value);
      expect((await h.collect()).quote.status).toBe("unknown");
    }
    const h = harness();
    h.quote({ ...quote(start), expiresAt: new Date(start + 2000).toISOString() });
    const result = await h.collect();
    expect(result.quote.status).toBe("fresh");
    expect(toScoreEvidence(result, start + 2000).quote).toBeNull();
  });

  test("optional data must match the mint and preserve its source timestamp", async () => {
    const h = harness({
      holders: async () => ({ mintAddress: mint, percentage: 25, fetchedAtMs: start - 1000 }),
      creator: async () => ({ mintAddress: mint, percentage: 4, fetchedAtMs: start - 301_000 }),
    });
    const result = await h.collect();
    expect(result.holders).toMatchObject({ status: "fresh", fetchedAtMs: start - 1000 });
    expect(result.creator.status).toBe("stale");
    const wrong = harness({ holders: async () => ({ mintAddress: creator, percentage: 1, fetchedAtMs: start }) });
    expect((await wrong.collect()).holders.status).toBe("unknown");
  });

  test("only fresh same-asset Pyth prices yield oracle evidence", async () => {
    const observation: Evidence<PythPrice> = {
      status: "fresh",
      value: { mintAddress: mint, feedId, priceUsd: 15 },
      fetchedAtMs: start - 1000,
      expiresAtMs: start + 9000,
    };
    const h = harness();
    h.oracle(observation);
    const result = await h.collect();
    expect(result.oracle).toMatchObject({
      source: "pyth",
      deviationBps: 0,
      mintAddress: mint,
      fetchedAtMs: start - 1000,
    });
    expect(toScoreEvidence(result, start + 9000).oracle).toBeNull();
    for (const invalid of [
      { ...observation, value: { ...observation.value, mintAddress: WRAPPED_SOL_MINT } },
      { ...observation, fetchedAtMs: start - 11_000, expiresAtMs: start - 1000 },
      { ...observation, fetchedAtMs: start + 1000 },
    ]) {
      h.oracle(invalid);
      expect((await h.collect()).oracle.source).toBe("none");
    }
  });
});

describe("Pyth HTTP boundary", () => {
  test("no configured feed or key makes no request", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: Parameters<typeof fetch>[0]) => {
      calls++;
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    expect((await new PythPrices({ apiKey: "private", feeds: {}, fetchImpl }).get(mint)).status).toBe("unknown");
    expect((await new PythPrices({ feeds: { [mint]: feedId }, fetchImpl }).get(mint)).status).toBe("unknown");
    expect(calls).toBe(0);
  });

  test("authenticates exact feed, validates identity, positivity, confidence and publish time", async () => {
    for (const variant of ["good", "mismatch", "old", "future", "zero", "wide", "malformed", "failure"]) {
      let called = false;
      const pyth = new PythPrices({
        apiKey: "private",
        feeds: { [mint]: feedId },
        now: () => start,
        fetchImpl: (async (url, init) => {
          called = true;
          expect(new URL(String(url)).searchParams.get("ids[]")).toBe(feedId);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private");
          expect(init?.redirect).toBe("error");
          if (variant === "failure") return new Response("private-error", { status: 503 });
          if (variant === "malformed") return Response.json({ parsed: [] });
          return Response.json({
            parsed: [
              {
                id: variant === "mismatch" ? "cd".repeat(32) : feedId,
                price: {
                  price: variant === "zero" ? "0" : "1500000000",
                  conf: variant === "wide" ? "1000000000" : "100",
                  expo: -8,
                  publish_time: (start + (variant === "old" ? -11_000 : variant === "future" ? 1000 : 0)) / 1000,
                },
              },
            ],
          });
        }) as typeof fetch,
      });
      const result = await pyth.get(mint);
      expect(called).toBe(true);
      expect(result.status).toBe(variant === "good" ? "fresh" : variant === "old" ? "stale" : "unknown");
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });
});

test("cache bounds pending work, expires unknown results and evicts old entries", async () => {
  let now = start;
  const cache = new EvidenceCache<number>(() => now, 1);
  let release: (() => void) | undefined;
  const pending = cache.get("a", async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { value: 1, fetchedAtMs: now, expiresAtMs: now + 1000 };
  });
  await Promise.resolve();
  expect(
    await cache.get("b", async () => {
      throw new Error();
    }),
  ).toMatchObject({ status: "unknown", reason: "evidence-capacity" });
  release?.();
  await pending;
  await cache.get("b", async () => ({ value: 2, fetchedAtMs: now, expiresAtMs: now + 1000 }));
  let reloaded = false;
  await cache.get("a", async () => {
    reloaded = true;
    throw new Error("secret");
  });
  expect(reloaded).toBe(true);
  now += 2000;
  expect(await cache.get("a", async () => ({ value: 3, fetchedAtMs: now, expiresAtMs: now + 1000 }))).toMatchObject({
    status: "fresh",
    value: 3,
  });
});

test("evidence config bounds size and rejects malformed feed mapping without leaking secrets", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/waffle",
    HELIUS_RPC_URL: "https://rpc.test",
    HELIUS_WSS_URL: "wss://rpc.test",
    JUPITER_API_KEY: "private",
  };
  expect(parseWatcherEnv(env)).toMatchObject({ WATCHER_COPY_SIZE_LAMPORTS: 50_000_000n, PYTH_PRICE_FEEDS_JSON: {} });
  for (const overrides of [
    { WATCHER_COPY_SIZE_LAMPORTS: "49999999" },
    { WATCHER_COPY_SIZE_LAMPORTS: "100000001" },
    { PYTH_PRICE_FEEDS_JSON: "private-invalid-json" },
    { PYTH_PRICE_FEEDS_JSON: JSON.stringify({ [mint]: "SOL" }) },
  ]) {
    try {
      parseWatcherEnv({ ...env, ...overrides });
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).toContain("Invalid watcher environment");
      expect(String(error)).not.toContain("private");
    }
  }
});
