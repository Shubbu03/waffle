import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { classifyPumpSwapBuy } from "@waffle/market-data/classify";
import type { PythPrices } from "@waffle/market-data/pyth";
import {
  PUMP_SWAP_PROGRAM_ID,
  type SignalDetail,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  TOKEN_2022_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { createTradeAssessor, TradeAssessmentError } from "../src/trade-assessment.ts";

const source = await Bun.file(new URL("../../../tests/fixtures/pumpswap-buy.json", import.meta.url)).json();
const signature = source.transaction.signatures[0];
const wallet = source.transaction.message.accountKeys.find((k: { signer: boolean }) => k.signer).pubkey;
const classified = classifyPumpSwapBuy(source, wallet, signature);
if (classified.status !== "buy") throw new Error("Expected supported fixture");
const buy = classified.buy;
const address = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const creator = address(8);
const baseVault = address(9);
const quoteVault = address(10);
const [poolKey, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("pool"),
    Buffer.alloc(2),
    new PublicKey(creator).toBuffer(),
    new PublicKey(buy.mintAddress).toBuffer(),
    new PublicKey(WRAPPED_SOL_MINT).toBuffer(),
  ],
  new PublicKey(PUMP_SWAP_PROGRAM_ID),
);
const pool = poolKey.toBase58();
const transaction = JSON.parse(JSON.stringify(source).replaceAll(buy.poolAddress, pool));
const start = 1_800_000_000_000;
const account = (data: Buffer, owner = SPL_TOKEN_PROGRAM_ID) => ({
  owner,
  executable: false,
  data: [data.toString("base64"), "base64"],
});

function harness() {
  let now = start;
  let failure = false;
  let tx = structuredClone(transaction);
  let probes = 0;
  let oracle: Awaited<ReturnType<PythPrices["get"]>> = { status: "unknown", reason: "missing" };
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const poolData = Buffer.alloc(271);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(poolData);
  poolData[8] = bump;
  for (const [key, offset] of [
    [creator, 11],
    [buy.mintAddress, 43],
    [WRAPPED_SOL_MINT, 75],
    [baseVault, 139],
    [quoteVault, 171],
  ] as const)
    new PublicKey(key).toBuffer().copy(poolData, offset);
  const vault = (mintAddress: string, amount: bigint) => {
    const data = Buffer.alloc(165);
    new PublicKey(mintAddress).toBuffer().copy(data);
    new PublicKey(pool).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return data;
  };
  const base = vault(buy.mintAddress, 1_000_000_000n);
  const quote = vault(WRAPPED_SOL_MINT, 300_000_000_000n);
  const accounts = new Map([
    [buy.mintAddress, account(mint)],
    [pool, account(poolData, PUMP_SWAP_PROGRAM_ID)],
    [baseVault, account(base)],
    [quoteVault, account(quote)],
  ]);
  const score = scoreSignal({
    mintAddress: buy.mintAddress,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: buy.slot,
    currentSlot: buy.slot,
    observedAtMs: start - 86400_000,
    nowMs: start,
    mint: null,
    pool: null,
    quote: null,
    holders: null,
    creator: null,
    oracle: null,
  });
  const signal: SignalDetail = {
    id: crypto.randomUUID(),
    eventId: "1",
    signature,
    walletId: crypto.randomUUID(),
    walletAddress: wallet,
    mintAddress: buy.mintAddress,
    sourceProgramId: PUMP_SWAP_PROGRAM_ID,
    slot: buy.slot,
    observedAt: new Date(start - 86400_000).toISOString(),
    publishedAt: new Date(start).toISOString(),
    scoreVersion: 1,
    score: score.score,
    status: score.status,
    dataStatus: "unknown",
    reasons: [...score.reasons],
    snapshot: {
      transactionSlot: buy.slot,
      currentSlot: buy.slot,
      mint: null,
      pool: null,
      quote: null,
      holders: null,
      creator: null,
      oracle: null,
    },
  };
  const assessor = createTradeAssessor({
    now: () => now,
    rpc: {
      async getTransaction() {
        if (failure) throw new Error("secret-rpc-url");
        return tx;
      },
      async getMultipleAccounts(keys) {
        return { context: { slot: buy.slot + 100 }, value: keys.map((k) => accounts.get(k) ?? null) };
      },
      async getBlockTime() {
        return now / 1000;
      },
    },
    jupiter: {
      async getPaperQuote() {
        probes++;
        throw new Error("Trade uses its own size-specific quote");
      },
      async getUsdPrice() {
        return { usdPrice: 150, decimals: 9, blockId: buy.slot };
      },
    },
    pyth: {
      async get() {
        return oracle;
      },
    },
  });
  return {
    assessor,
    signal,
    accounts,
    mint,
    quote,
    get probes() {
      return probes;
    },
    set time(value: number) {
      now = value;
    },
    set failed(value: boolean) {
      failure = value;
    },
    set transaction(value: typeof tx) {
      tx = value;
    },
    set oracle(value: typeof oracle) {
      oracle = value;
    },
  };
}

test("revalidates a historical suppressed buy against current verified accounts without rewriting its score", async () => {
  const h = harness();
  const original = structuredClone(h.signal);
  const assessment = await h.assessor.assess(h.signal, "real", "10000000");
  expect(assessment.pool.liquidityUsd).toBe(90000);
  expect(assessment.pool.address).toBe(pool);
  expect(assessment.mint.decimals).toBe(6);
  expect(assessment.mint.fetchedAt).toBe(new Date(start).toISOString());
  expect(h.signal).toEqual(original);
  expect(h.probes).toBe(0);
  // Another review reads current accounts rather than reusing the previous assessment.
  h.mint.writeUInt32LE(1, 0);
  h.accounts.set(buy.mintAddress, account(h.mint));
  await expect(h.assessor.assess(h.signal, "real", "10000000")).rejects.toMatchObject({ status: 409 });
});

test("failed or mismatched source transactions cannot authorize a manual trade", async () => {
  const h = harness();
  const failed = structuredClone(transaction);
  failed.meta.err = { custom: 1 };
  h.transaction = failed;
  await expect(h.assessor.assess(h.signal, "paper", "10000000")).rejects.toMatchObject({ code: "STALE_SIGNAL" });
  h.transaction = transaction;
  await expect(h.assessor.assess({ ...h.signal, mintAddress: address(4) }, "paper", "10000000")).rejects.toMatchObject({
    code: "STALE_SIGNAL",
  });
});

test("current liquidity floors distinguish paper and real trades; missing vault evidence never passes", async () => {
  const h = harness();
  h.quote.writeBigUInt64LE(100_000_000_000n, 64);
  h.accounts.set(quoteVault, account(h.quote));
  expect((await h.assessor.assess(h.signal, "paper", "100000000")).pool.liquidityUsd).toBe(30000);
  await expect(h.assessor.assess(h.signal, "real", "10000000")).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  h.accounts.delete(baseVault);
  await expect(h.assessor.assess(h.signal, "paper", "10000000")).rejects.toMatchObject({ status: 503 });
});

test("Token-2022 is accepted with no authority; a present freeze authority blocks", async () => {
  const h = harness();
  h.accounts.set(buy.mintAddress, account(h.mint, TOKEN_2022_PROGRAM_ID));
  expect((await h.assessor.assess(h.signal, "paper", "10000000")).mint.tokenProgramId).toBe(TOKEN_2022_PROGRAM_ID);
  h.mint.writeUInt32LE(1, 46);
  h.accounts.set(buy.mintAddress, account(h.mint, TOKEN_2022_PROGRAM_ID));
  await expect(h.assessor.assess(h.signal, "paper", "10000000")).rejects.toMatchObject({ status: 409 });
});

test("fresh same-asset oracle disagreement blocks; missing oracle does not", async () => {
  const h = harness();
  h.oracle = {
    status: "fresh",
    value: { mintAddress: buy.mintAddress, feedId: "ab".repeat(32), priceUsd: 10 },
    fetchedAtMs: start,
    expiresAtMs: start + 10000,
  };
  await expect(h.assessor.assess(h.signal, "real", "10000000")).rejects.toMatchObject({ code: "STALE_SIGNAL" });
});

test("provider failures return a retryable error without leaking credentials", async () => {
  const h = harness();
  h.failed = true;
  try {
    await h.assessor.assess(h.signal, "real", "10000000");
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TradeAssessmentError);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(String(error)).not.toContain("secret-rpc-url");
    expect((error as Error).cause).toBeUndefined();
  }
});
