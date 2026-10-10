import { afterEach, expect, test } from "bun:test";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { HttpTransport } from "@waffle/http";
import {
  PUMP_SWAP_PROGRAM_ID,
  type SignalDetail,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import bs58 from "bs58";
import { classifyPumpSwapBuy } from "../src/classify.ts";
import { DEVNET_GENESIS_HASH, DevnetPumpSwap } from "../src/devnet-pumpswap.ts";
import { MarketRpc } from "../src/rpc.ts";

const source = await Bun.file(new URL("../../../tests/fixtures/pumpswap-buy.json", import.meta.url)).json();
const configuration = await Bun.file(
  new URL("../../../tests/fixtures/devnet-pumpswap-config.json", import.meta.url),
).json();
const originalWallet = source.transaction.message.accountKeys.find((k: { signer: boolean }) => k.signer).pubkey;
const classified = classifyPumpSwapBuy(source, originalWallet, source.transaction.signatures[0]);
if (classified.status !== "buy") throw new Error("Expected buy fixture");
const buy = classified.buy;
const running: MarketRpc[] = [];
afterEach(() => {
  for (const rpc of running.splice(0)) rpc.close();
});
function fixture() {
  let now = Date.now(),
    genesis = DEVNET_GENESIS_HASH,
    simulationError: unknown = null,
    balance = 10_000_000_000;
  let broadcasts = 0,
    broadcastLost = false;
  const wallet = Keypair.generate();
  const creator = new PublicKey(new Uint8Array(32).fill(8));
  const baseVault = new PublicKey(new Uint8Array(32).fill(9));
  const quoteVault = new PublicKey(new Uint8Array(32).fill(10));
  const [pool, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      Buffer.alloc(2),
      creator.toBuffer(),
      new PublicKey(buy.mintAddress).toBuffer(),
      new PublicKey(WRAPPED_SOL_MINT).toBuffer(),
    ],
    new PublicKey(PUMP_SWAP_PROGRAM_ID),
  );
  const rawPool = Buffer.alloc(300);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(rawPool);
  rawPool[8] = bump;
  for (const [key, offset] of [
    [creator, 11],
    [new PublicKey(buy.mintAddress), 43],
    [new PublicKey(WRAPPED_SOL_MINT), 75],
    [baseVault, 139],
    [quoteVault, 171],
  ] as const)
    key.toBuffer().copy(rawPool, offset);
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  mint.writeBigUInt64LE(1_000_000_000_000n, 36);
  const quoteMint = Buffer.from(mint);
  quoteMint[44] = 9;
  const vault = (mintAddress: string, amount: bigint) => {
    const data = Buffer.alloc(165);
    new PublicKey(mintAddress).toBuffer().copy(data);
    pool.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return data;
  };
  const account = (data: Buffer, owner = SPL_TOKEN_PROGRAM_ID) => ({
    data: [data.toString("base64"), "base64"],
    owner,
    executable: false,
    lamports: 10_000_000,
    rentEpoch: 0,
  });
  const accounts = new Map<string, unknown>(
    configuration.keys.map((key: string, index: number) => [key, configuration.result.value[index]]),
  );
  accounts.set(pool.toBase58(), account(rawPool, PUMP_SWAP_PROGRAM_ID));
  accounts.set(buy.mintAddress, account(mint));
  accounts.set(WRAPPED_SOL_MINT, account(quoteMint));
  accounts.set(baseVault.toBase58(), account(vault(buy.mintAddress, 1_000_000_000_000n)));
  accounts.set(quoteVault.toBase58(), account(vault(WRAPPED_SOL_MINT, 300_000_000_000n)));
  let transaction = JSON.parse(
    JSON.stringify(source)
      .replaceAll(buy.poolAddress, pool.toBase58())
      .replaceAll(originalWallet, wallet.publicKey.toBase58()),
  );
  const methods: string[] = [];
  const transport: HttpTransport = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    methods.push(request.method);
    let result: unknown;
    switch (request.method) {
      case "getGenesisHash":
        result = genesis;
        break;
      case "getMultipleAccounts":
        result = {
          context: { slot: buy.slot + 100 },
          value: request.params[0].map((key: string) => accounts.get(key) ?? null),
        };
        break;
      case "getAccountInfo":
        result = { context: { slot: buy.slot + 100 }, value: accounts.get(request.params[0]) ?? null };
        break;
      case "getTransaction":
        result = transaction;
        break;
      case "getLatestBlockhash":
        result = {
          context: { slot: buy.slot + 100 },
          value: { blockhash: WRAPPED_SOL_MINT, lastValidBlockHeight: 12345 },
        };
        break;
      case "getFeeForMessage":
        result = { context: { slot: buy.slot + 100 }, value: 5000 };
        break;
      case "getMinimumBalanceForRentExemption":
        result = 2_039_280;
        break;
      case "getBalance":
        result = { context: { slot: buy.slot + 100 }, value: balance };
        break;
      case "simulateTransaction":
        result = { context: { slot: buy.slot + 100 }, value: { err: simulationError } };
        break;
      case "sendTransaction": {
        broadcasts++;
        if (broadcastLost) throw new TypeError("response lost");
        const tx = VersionedTransaction.deserialize(Buffer.from(request.params[0], "base64"));
        result = bs58.encode(tx.signatures[0] ?? new Uint8Array());
        break;
      }
      case "getSignatureStatuses":
        result = { context: { slot: buy.slot + 100 }, value: [{ err: null, confirmationStatus: "confirmed" }] };
        break;
      default:
        throw new Error(`Unexpected RPC ${request.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  const rpc = new MarketRpc({ url: "https://devnet.test", requestsPerSecond: 10, transport });
  running.push(rpc);
  const provider = new DevnetPumpSwap(rpc, () => now);
  const score = scoreSignal({
    mintAddress: buy.mintAddress,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: buy.slot,
    currentSlot: buy.slot,
    observedAtMs: now,
    nowMs: now,
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
    walletId: crypto.randomUUID(),
    walletAddress: wallet.publicKey.toBase58(),
    signature: buy.signature,
    mintAddress: buy.mintAddress,
    sourceProgramId: PUMP_SWAP_PROGRAM_ID,
    slot: buy.slot,
    observedAt: new Date(now).toISOString(),
    publishedAt: new Date(now).toISOString(),
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
  const request = {
    signalId: signal.id,
    outputMint: signal.mintAddress,
    inputAmountLamports: "10000000",
    taker: signal.walletAddress,
  };
  return {
    provider,
    rpc,
    wallet,
    signal,
    request,
    methods,
    mint,
    accounts,
    async prepare() {
      await provider.assess(signal, "real", request.inputAmountLamports);
      return provider.getRealOrder(request, request.taker);
    },
    setGenesis(value: string) {
      genesis = value;
    },
    setSimulationError(value: unknown) {
      simulationError = value;
    },
    setBalance(value: number) {
      balance = value;
    },
    setNow(value: number) {
      now = value;
    },
    setLost() {
      broadcastLost = true;
    },
    broadcasts: () => broadcasts,
    setTransaction(value: unknown) {
      transaction = value;
    },
  };
}

test("Devnet quote uses real SDK fees and builds a bounded single-signer PumpSwap transaction", async () => {
  const f = fixture();
  const assessment = await f.provider.assess(f.signal, "real", "10000000");
  expect(assessment.network).toBe("devnet");
  expect(assessment.pool.liquidityUsd).toBeNull();
  expect(assessment.pool.quoteReserveLamports).toBe("300000000000");
  const paper = await f.provider.getPaperQuote({
    signalId: f.signal.id,
    outputMint: f.signal.mintAddress,
    inputAmountLamports: "10000000",
  });
  const exit = await f.provider.getPaperValuation({
    positionId: crypto.randomUUID(),
    signalId: f.signal.id,
    inputMint: f.signal.mintAddress,
    inputAmountRaw: paper.minOutputAmountRaw,
  });
  expect(BigInt(exit.outputLamports)).toBeGreaterThan(0n);
  expect(paper.router).toBe("pumpswap");
  expect(paper.network).toBe("devnet");
  expect(BigInt(paper.outputAmountRaw)).toBeGreaterThan(0n);
  const order = await f.provider.getRealOrder(f.request, f.request.taker);
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transactionBase64, "base64"));
  expect(tx.message.header.numRequiredSignatures).toBe(1);
  expect(tx.message.staticAccountKeys[0]?.toBase58()).toBe(f.request.taker);
  const swap = tx.message.compiledInstructions.find(
    (ix) =>
      tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() === PUMP_SWAP_PROGRAM_ID &&
      Buffer.from(ix.data).subarray(0, 8).toString("hex") === "66063d1201daebea",
  );
  expect(swap).toBeDefined();
  if (!swap) throw new Error("Missing swap instruction");
  expect(Buffer.from(swap.data).readBigUInt64LE(16)).toBe(10_000_000n);
  expect(f.methods).toContain("simulateTransaction");
  expect(f.broadcasts()).toBe(0);
}, 15000);

test("wrong-network RPC, enabled mint authority and failed simulation cannot produce executable orders", async () => {
  const wrong = fixture();
  wrong.setGenesis("mainnet-genesis");
  await expect(wrong.prepare()).rejects.toMatchObject({ code: "UNSUPPORTED_ORDER" });
  expect(wrong.methods).toEqual(["getGenesisHash"]);
  const unsafe = fixture();
  unsafe.mint.writeUInt32LE(1, 0);
  unsafe.accounts.set(unsafe.signal.mintAddress, {
    owner: SPL_TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 10000000,
    rentEpoch: 0,
    data: [unsafe.mint.toString("base64"), "base64"],
  });
  await expect(unsafe.prepare()).rejects.toMatchObject({ code: "UNSUPPORTED_ORDER" });
  const fail = fixture();
  fail.setSimulationError({ InstructionError: [0, "Custom"] });
  await expect(fail.prepare()).rejects.toMatchObject({ code: "ORDER_BUILD_FAILED" });
  expect(fail.broadcasts()).toBe(0);
}, 15000);

test("a signed Devnet transaction is validated before the only broadcast; a lost response never retries", async () => {
  const f = fixture();
  const order = await f.prepare();
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transactionBase64, "base64"));
  tx.sign([f.wallet]);
  f.setLost();
  let validated = 0;
  await expect(
    f.provider.execute(
      {
        orderId: order.id,
        requestId: order.requestId,
        signedTransactionBase64: Buffer.from(tx.serialize()).toString("base64"),
      },
      order.taker,
      async () => {
        validated++;
        expect(f.broadcasts()).toBe(0);
      },
    ),
  ).rejects.toMatchObject({ code: "EXECUTION_UNKNOWN" });
  expect(validated).toBe(1);
  expect(f.broadcasts()).toBe(1);
  await expect(
    f.provider.execute(
      {
        orderId: order.id,
        requestId: order.requestId,
        signedTransactionBase64: Buffer.from(tx.serialize()).toString("base64"),
      },
      order.taker,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ORDER" });
  expect(f.broadcasts()).toBe(1);
}, 15000);

test("mutated transaction bytes and insufficient Devnet SOL never dispatch", async () => {
  const low = fixture();
  low.setBalance(100);
  await expect(low.prepare()).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  const f = fixture();
  const order = await f.prepare();
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transactionBase64, "base64"));
  tx.message.recentBlockhash = PUMP_SWAP_PROGRAM_ID;
  tx.sign([f.wallet]);
  await expect(
    f.provider.execute(
      {
        orderId: order.id,
        requestId: order.requestId,
        signedTransactionBase64: Buffer.from(tx.serialize()).toString("base64"),
      },
      order.taker,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ORDER" });
  expect(f.broadcasts()).toBe(0);
}, 15000);

test("read-only confirmation recovers after a lost response and reports the observed spend", async () => {
  const f = fixture();
  const order = await f.prepare();
  const signed = VersionedTransaction.deserialize(Buffer.from(order.transactionBase64, "base64"));
  signed.sign([f.wallet]);
  const signature = bs58.encode(signed.signatures[0] ?? new Uint8Array());
  f.setLost();
  await expect(
    f.provider.execute(
      {
        orderId: order.id,
        requestId: order.requestId,
        signedTransactionBase64: Buffer.from(signed.serialize()).toString("base64"),
      },
      order.taker,
    ),
  ).rejects.toMatchObject({ code: "EXECUTION_UNKNOWN" });
  const confirmed = JSON.parse(JSON.stringify(source).replaceAll(originalWallet, order.taker));
  confirmed.transaction.signatures[0] = signature;
  const ata = PublicKey.findProgramAddressSync(
    [
      f.wallet.publicKey.toBuffer(),
      new PublicKey(SPL_TOKEN_PROGRAM_ID).toBuffer(),
      new PublicKey(WRAPPED_SOL_MINT).toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0].toBase58();
  confirmed.meta.innerInstructions = [
    {
      index: 0,
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: { type: "transferChecked", info: { source: ata, tokenAmount: { amount: "9000000" } } },
        },
      ],
    },
  ];
  f.setTransaction(confirmed);
  const result = await f.provider.getExecution(signature, order.requestId, order.taker, order.outputMint);
  expect(result?.status).toBe("confirmed");
  expect(result && "inputAmountResultRaw" in result && result.inputAmountResultRaw).toBe("9000000");
  expect(f.broadcasts()).toBe(1);
}, 15000);
