import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAuthStore, type DatabaseTransaction } from "@waffle/db";
import { sessions, signalEvents, signals, tradeAttempts, users, watchedWallets } from "@waffle/db/schema";
import type { HttpTransport } from "@waffle/http";
import { createLogger } from "@waffle/observability";
import {
  apiErrorSchema,
  PUMP_SWAP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  scorePolicyV1,
  scoreSignal,
  tradeAttemptOrderResponseSchema,
  tradeAttemptSchema,
  tradeAttemptsResponseSchema,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import bs58 from "bs58";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";
import { JupiterService, JupiterServiceError } from "../src/jupiter.ts";
import type { TradeAssessor } from "../src/trade-assessment.ts";
import { createTradeAttemptService } from "../src/trade-attempts.ts";
import { assessmentFixture } from "./trade-assessment-fixture.ts";

let pg: PGlite;
let clock: number;
let assess: TradeAssessor["assess"];
let app: ReturnType<typeof createApp>;
let logs: Record<string, unknown>[];
let requests: Array<{ url: URL; init: RequestInit }>;
let orderReply: () => unknown;
let executionReply: () => unknown;
let afterOrder: () => Promise<void>;
let orderCalls: number;
const wallet = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const otherWallet = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 35));
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const walletId = "33333333-3333-4333-8333-333333333333";
const signalId = "44444444-4444-4444-8444-444444444444";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const amount = "50000000";
const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE trade_api_test`);
    return run(tx);
  });
const auth = createAuthStore(transaction);
const message = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: PublicKey.default.toBase58(),
  instructions: [
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: otherWallet.publicKey, lamports: 1 }),
  ],
}).compileToV0Message();
const unsignedBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
const signed = new VersionedTransaction(message);
signed.sign([wallet]);
const signedBase64 = Buffer.from(signed.serialize()).toString("base64");
const signedSignature = bs58.encode(signed.signatures[0] ?? new Uint8Array());
function upstreamOrder(overrides: Record<string, unknown> = {}) {
  return {
    inputMint: WRAPPED_SOL_MINT,
    outputMint: PUMP_SWAP_PROGRAM_ID,
    inAmount: amount,
    outAmount: "1000",
    otherAmountThreshold: "950",
    requestId: `provider-${++orderCalls}`,
    router: "metis",
    priceImpact: -0.5,
    slippageBps: 500,
    feeBps: 10,
    feeMint: PUMP_SWAP_PROGRAM_ID,
    platformFee: null,
    signatureFeeLamports: 5000,
    signatureFeePayer: wallet.publicKey.toBase58(),
    prioritizationFeeLamports: 1000,
    prioritizationFeePayer: wallet.publicKey.toBase58(),
    rentFeeLamports: 0,
    rentFeePayer: wallet.publicKey.toBase58(),
    gasless: false,
    taker: wallet.publicKey.toBase58(),
    transaction: unsignedBase64,
    lastValidBlockHeight: "123456789",
    ...overrides,
  };
}
const request = (method: string, path: string, body?: unknown, bearer = tokenA) =>
  app.request(`/trade-attempts${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const prepare = (body: unknown = { signalId, inputAmountLamports: amount }, bearer = tokenA) =>
  request("POST", "", body, bearer);
const prepared = async () => tradeAttemptOrderResponseSchema.parse(await (await prepare()).json());
const execution = (
  attempt: { id: string; quoteId: string; requestId: string },
  bearer = tokenA,
  encoded = signedBase64,
) =>
  request(
    "POST",
    `/${attempt.id}/execute`,
    { quoteId: attempt.quoteId, requestId: attempt.requestId, signedTransactionBase64: encoded },
    bearer,
  );

beforeAll(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec("CREATE ROLE trade_api_test LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO trade_api_test");
  await drizzle(pg)
    .insert(watchedWallets)
    .values({ id: walletId, address: WRAPPED_SOL_MINT, label: "Test", inclusionReason: "Test" });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  logs = [];
  clock = Date.now();
  assess = async (signal, mode, size) => assessmentFixture(signal, mode, size, clock);
  requests = [];
  orderCalls = 0;
  afterOrder = async () => {};
  orderReply = () => upstreamOrder();
  executionReply = () => ({
    status: "Success",
    code: 0,
    signature: signedSignature,
    totalInputAmount: amount,
    totalOutputAmount: "990",
    inputAmountResult: amount,
    outputAmountResult: "990",
  });
  await pg.exec("TRUNCATE users, signals CASCADE");
  const db = drizzle(pg);
  await db.update(watchedWallets).set({ network: "mainnet" }).where(eq(watchedWallets.id, walletId));
  await db.insert(users).values([
    { id: ownerA, walletAddress: wallet.publicKey.toBase58() },
    { id: ownerB, walletAddress: otherWallet.publicKey.toBase58() },
  ]);
  await db.insert(sessions).values([
    { userId: ownerA, tokenHash: hashSecret(tokenA), expiresAt: new Date(clock + 60000) },
    { userId: ownerB, tokenHash: hashSecret(tokenB), expiresAt: new Date(clock + 60000) },
  ]);
  const iso = new Date(clock).toISOString();
  const scored = scoreSignal({
    mintAddress: PUMP_SWAP_PROGRAM_ID,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: 100,
    currentSlot: 101,
    observedAtMs: clock,
    nowMs: clock,
    mint: {
      address: PUMP_SWAP_PROGRAM_ID,
      tokenProgramId: SPL_TOKEN_PROGRAM_ID,
      mintAuthority: null,
      freezeAuthority: null,
      fetchedAtMs: clock,
    },
    pool: { baseMint: PUMP_SWAP_PROGRAM_ID, quoteMint: WRAPPED_SOL_MINT, liquidityUsd: 100_000, fetchedAtMs: clock },
    quote: {
      inputMint: WRAPPED_SOL_MINT,
      outputMint: PUMP_SWAP_PROGRAM_ID,
      inputLamports: 50_000_000n,
      outputAmountRaw: 1000n,
      fetchedAtMs: clock,
    },
    holders: null,
    creator: null,
    oracle: null,
  });
  const fresh = { status: "fresh" as const, expiresAt: new Date(clock + 10_000).toISOString(), reason: null };
  const unknown = { status: "unknown" as const, expiresAt: null, reason: "unavailable" };
  await db.insert(signals).values({
    id: signalId,
    signature: "1".repeat(64),
    walletId,
    mintAddress: PUMP_SWAP_PROGRAM_ID,
    sourceProgramId: PUMP_SWAP_PROGRAM_ID,
    slot: 100,
    observedAt: new Date(clock),
    publishedAt: new Date(clock),
    scoreVersion: 1,
    score: scored.score,
    status: scored.status,
    dataStatus: "partial",
    reasons: [...scored.reasons],
    snapshot: {
      transactionSlot: 100,
      currentSlot: 101,
      mint: {
        address: PUMP_SWAP_PROGRAM_ID,
        tokenProgramId: SPL_TOKEN_PROGRAM_ID,
        mintAuthority: null,
        freezeAuthority: null,
        fetchedAt: iso,
      },
      pool: { baseMint: PUMP_SWAP_PROGRAM_ID, quoteMint: WRAPPED_SOL_MINT, liquidityUsd: 100_000, fetchedAt: iso },
      quote: {
        inputMint: WRAPPED_SOL_MINT,
        outputMint: PUMP_SWAP_PROGRAM_ID,
        inputLamports: "50000000",
        outputAmountRaw: "1000",
        fetchedAt: iso,
      },
      holders: null,
      creator: null,
      oracle: null,
      assessment: {
        scoredAt: iso,
        transactionAt: iso,
        source: "provisional",
        streamStale: false,
        evidence: { mint: fresh, pool: fresh, quote: fresh, holders: unknown, creator: unknown, oracle: unknown },
      },
    },
  });
  await db.insert(signalEvents).values({ signalId });

  const fakeTransport = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed, init });
    if (parsed.pathname.endsWith("/execute")) return Response.json(executionReply());
    await afterOrder();
    return Response.json(orderReply());
  }) as HttpTransport;
  const jupiter = new JupiterService("server-test-key", fakeTransport, () => clock);
  app = createApp(
    { async ping() {} },
    { store: auth, uri: "https://waffle.example" },
    undefined,
    undefined,
    undefined,
    { jupiter, now: () => clock, assessor: { assess: (...args) => assess(...args) } },
    createLogger({ service: "api", write: (line) => logs.push(JSON.parse(line)) }),
  );
});

test("a real order is issued for the authenticated wallet and persisted before signing", async () => {
  const response = await prepare();
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { attempt, order } = tradeAttemptOrderResponseSchema.parse(await response.json());
  expect(attempt).toMatchObject({
    signalId,
    quoteId: order.id,
    requestId: order.requestId,
    taker: wallet.publicKey.toBase58(),
    router: "metis",
    inputAmountLamports: amount,
    status: "prepared",
  });
  expect(order).toMatchObject({ kind: "real", requiredSignatures: 1, signatureFeePayer: wallet.publicKey.toBase58() });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url.searchParams.get("taker")).toBe(wallet.publicKey.toBase58());
  expect(requests[0]?.url.searchParams.get("excludeRouters")).toBe("jupiterz");
  expect((await drizzle(pg).select().from(tradeAttempts))[0]).toMatchObject({
    userId: ownerA,
    quoteId: order.id,
    requestId: order.requestId,
  });
});

test("empty Jupiter transactions explain funding or build failures and never prepare execution", async () => {
  for (const router of ["metis", "dflow", "okx"]) {
    for (const [errorCode, message] of [
      [1, "enough SOL"],
      [2, "network fees"],
      [3, "could not build"],
    ] as const) {
      orderReply = () =>
        upstreamOrder({
          router,
          errorCode,
          transaction: "",
          lastValidBlockHeight: null,
          errorMessage: "private upstream diagnostic",
        });
      const response = await prepare();
      expect(response.status).toBe(409);
      const body = apiErrorSchema.parse(await response.json());
      expect(body.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(body.error.message).toContain(message);
      expect(JSON.stringify(body)).not.toContain("private upstream");
    }
  }
  expect(await drizzle(pg).select().from(tradeAttempts)).toHaveLength(0);
});

test("Jupiter throttling asks the user to wait without preparing or retrying an order", async () => {
  orderReply = () => {
    throw new JupiterServiceError("UPSTREAM_UNAVAILABLE", 429);
  };
  const response = await prepare();
  expect(response.status).toBe(503);
  expect(apiErrorSchema.parse(await response.json()).error.message).toContain("quote service is busy");
  expect(requests).toHaveLength(1);
  expect(await drizzle(pg).select().from(tradeAttempts)).toHaveLength(0);
});

test("duplicate request IDs and mismatched provider orders cannot create a second attempt", async () => {
  orderReply = () => upstreamOrder({ requestId: "same-provider-request" });
  expect((await prepare()).status).toBe(201);
  expect((await prepare()).status).toBe(409);
  expect(await drizzle(pg).select().from(tradeAttempts)).toHaveLength(1);
  for (const override of [
    { taker: otherWallet.publicKey.toBase58() },
    { outputMint: WRAPPED_SOL_MINT },
    { inAmount: "1000000" },
    { router: "jupiterz" },
    { signatureFeePayer: otherWallet.publicKey.toBase58() },
  ]) {
    orderReply = () => upstreamOrder(override);
    expect((await prepare()).status).not.toBe(201);
  }
  expect(await drizzle(pg).select().from(tradeAttempts)).toHaveLength(1);
});

test("unsupported buys, current low liquidity, oversized and unknown signals cannot issue orders", async () => {
  const db = drizzle(pg);
  expect((await prepare({ signalId: crypto.randomUUID(), inputAmountLamports: amount })).status).toBe(404);
  expect((await prepare({ signalId, inputAmountLamports: "50000001" })).status).toBe(400);
  expect(
    (await prepare({ signalId, inputAmountLamports: amount, taker: otherWallet.publicKey.toBase58() })).status,
  ).toBe(400);
  const [original] = await db.select().from(signals);
  if (!original) throw new Error("Missing test signal");
  await db.update(signals).set({
    status: "suppressed",
    score: original.score - scorePolicyV1.weights.supportedBuy,
    reasons: original.reasons.map((reason) =>
      reason.code === "supported_buy" ? { code: "unsupported_or_failed_transaction" as const, points: 0 } : reason,
    ),
  });
  expect((await prepare()).status).toBe(409);
  await db.update(signals).set({
    status: original.status,
    score: original.score,
    reasons: original.reasons,
    snapshot: sql`jsonb_set(snapshot, '{pool,liquidityUsd}', '50000'::jsonb)`,
  });
  assess = async (signal, mode, size) => {
    const a = assessmentFixture(signal, mode, size, clock);
    a.pool.liquidityUsd = 50000;
    return a;
  };
  expect((await prepare()).status).toBe(409);
  await db.update(signals).set({ snapshot: sql`jsonb_set(snapshot, '{pool,liquidityUsd}', '100000'::jsonb)` });
  expect((await prepare()).status).toBe(409);
  expect(requests).toEqual([]);
});

test("old and originally suppressed market checks can be reassessed for a real order", async () => {
  const db = drizzle(pg);
  const [before] = await db.select().from(signals);
  if (!before) throw new Error("Missing signal");
  await db.update(signals).set({
    observedAt: new Date(clock - 86400000),
    status: "suppressed",
    score: before.score - 20,
    reasons: before.reasons.map((r) =>
      r.code === "mint_safe" ? { code: "mint_unavailable_or_unsafe" as const, points: 0 } : r,
    ),
    snapshot: sql`jsonb_set(snapshot, '{pool,fetchedAt}', to_jsonb(${new Date(clock - 86400000).toISOString()}::text))`,
  });
  clock += 30000;
  const response = await prepare();
  expect(response.status).toBe(201);
  const result = tradeAttemptOrderResponseSchema.parse(await response.json());
  expect(result.order.assessment?.pool.liquidityUsd).toBe(100000);
  expect((await db.select().from(signals))[0]?.score).toBe(before.score - 20);
});

test("assessment expiry before signed execution prevents broadcast", async () => {
  assess = async (signal, mode, size) => ({
    ...assessmentFixture(signal, mode, size, clock),
    expiresAt: new Date(clock + 2000).toISOString(),
  });
  const { attempt } = await prepared();
  clock += 2000;
  const response = await execution(attempt);
  expect(response.status).toBe(409);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe("QUOTE_UNAVAILABLE");
  expect(requests.filter((r) => r.url.pathname.endsWith("/execute"))).toHaveLength(0);
  expect((await drizzle(pg).select().from(tradeAttempts))[0]?.status).toBe("prepared");
});

test("logout during provider I/O prevents an attempt from being stored", async () => {
  afterOrder = async () => {
    await auth.logout(hashSecret(tokenA));
  };
  expect((await prepare()).status).toBe(401);
  expect(await drizzle(pg).select().from(tradeAttempts)).toEqual([]);
});

test("owner-only reads, pagination, and cross-user execution are isolated", async () => {
  const { attempt } = await prepared();
  const { attempt: newer } = await prepared();
  expect((await request("GET", `/${attempt.id}`, undefined, tokenB)).status).toBe(404);
  expect((await execution(attempt, tokenB)).status).toBe(404);
  expect((await request("GET", "", undefined, tokenB)).status).toBe(200);
  expect(tradeAttemptsResponseSchema.parse(await (await request("GET", "", undefined, tokenB)).json()).items).toEqual(
    [],
  );
  expect((await request("GET", `?cursor=${attempt.id}`, undefined, tokenB)).status).toBe(404);
  expect(tradeAttemptSchema.parse(await (await request("GET", `/${attempt.id}`)).json()).id).toBe(attempt.id);
  const firstPage = tradeAttemptsResponseSchema.parse(await (await request("GET", "?limit=1")).json());
  expect(firstPage.items.map((item) => item.id)).toEqual([newer.id]);
  expect(firstPage.nextCursor).toBe(newer.id);
  const secondPage = tradeAttemptsResponseSchema.parse(
    await (await request("GET", `?limit=1&cursor=${firstPage.nextCursor}`)).json(),
  );
  expect(secondPage.items.map((item) => item.id)).toEqual([attempt.id]);
  expect(secondPage.nextCursor).toBeNull();
  expect((await execution(attempt, "c".repeat(43))).status).toBe(401);
});

test("a verified signed transaction transitions through submitted to confirmed once", async () => {
  const { attempt } = await prepared();
  expect((await execution({ ...attempt, quoteId: crypto.randomUUID() })).status).toBe(409);
  expect((await execution({ ...attempt, requestId: "wrong" })).status).toBe(409);
  expect((await execution(attempt, tokenA, unsignedBase64)).status).toBe(409);
  expect(requests).toHaveLength(1);
  const response = await execution(attempt);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    status: "confirmed",
    signature: signedSignature,
    executeCode: 0,
    failureReason: null,
  });
  expect((await drizzle(pg).select().from(tradeAttempts))[0]).toMatchObject({
    status: "confirmed",
    signature: signedSignature,
    executeCode: 0,
  });
  expect(requests.filter((request) => request.url.pathname.endsWith("/execute"))).toHaveLength(1);
  expect((await execution(attempt)).status).toBe(409);
});

test("wallet rejection records an explicit owner-only result and is idempotent", async () => {
  const { attempt } = await prepared();
  const body = { quoteId: attempt.quoteId, requestId: attempt.requestId, reason: "WALLET_REJECTED" };
  expect((await request("POST", `/${attempt.id}/wallet-rejection`, body, tokenB)).status).toBe(404);
  const first = await request("POST", `/${attempt.id}/wallet-rejection`, body);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    status: "wallet_rejected",
    failureReason: "WALLET_REJECTED",
    signature: null,
  });
  expect((await request("POST", `/${attempt.id}/wallet-rejection`, body)).status).toBe(200);
  expect((await request("POST", `/${attempt.id}/wallet-rejection`, { ...body, reason: "USER_CANCELLED" })).status).toBe(
    409,
  );
  expect((await execution(attempt)).status).toBe(409);
  expect(requests).toHaveLength(1);
});

test("Jupiter explicit failure stores code and the wallet's signed signature", async () => {
  executionReply = () => ({ status: "Failed", code: -1000, signature: null });
  const { attempt } = await prepared();
  const response = await execution(attempt);
  expect(response.status).toBe(200);
  expect((await drizzle(pg).select().from(tradeAttempts))[0]).toMatchObject({
    status: "failed",
    signature: signedSignature,
    executeCode: -1000,
    failureReason: "JUPITER_EXECUTION_FAILED",
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    event: "api.trade.failed",
    level: "warn",
    attemptId: attempt.id,
    code: "-1000",
    signature: signedSignature,
    requestId: response.headers.get("x-request-id"),
  });
});

test("execution timeout remains submitted and cannot rebroadcast; a mismatched success signature never confirms", async () => {
  const { attempt } = await prepared();
  executionReply = () => {
    throw new Error("simulated network timeout");
  };
  const first = await execution(attempt);
  expect(first.status).toBe(503);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    event: "api.request.failed",
    attemptId: attempt.id,
    requestId: first.headers.get("x-request-id"),
    error: { type: "TradeAttemptError", cause: { type: "JupiterServiceError", code: "EXECUTION_UNKNOWN" } },
  });
  expect(JSON.stringify(logs)).not.toContain("simulated network timeout");
  expect((await drizzle(pg).select().from(tradeAttempts))[0]).toMatchObject({
    status: "submitted",
    signature: signedSignature,
    failureReason: "EXECUTION_UNKNOWN",
  });
  expect((await execution(attempt)).status).toBe(409);
  expect(requests.filter((request) => request.url.pathname.endsWith("/execute"))).toHaveLength(1);
  const second = await prepared();
  executionReply = () => ({
    status: "Success",
    code: 0,
    signature: "1".repeat(64),
    totalInputAmount: amount,
    totalOutputAmount: "990",
    inputAmountResult: amount,
    outputAmountResult: "990",
  });
  expect((await execution(second.attempt)).status).toBe(503);
  expect(
    (await drizzle(pg).select().from(tradeAttempts).where(eq(tradeAttempts.id, second.attempt.id)))[0],
  ).toMatchObject({
    status: "submitted",
    failureReason: "SIGNATURE_MISMATCH",
  });
});

test("failed submission persistence prevents a provider broadcast and permits retry", async () => {
  const { attempt } = await prepared();
  await pg.exec(
    "CREATE FUNCTION reject_trade_submit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER reject_trade_submit BEFORE UPDATE ON trade_attempts FOR EACH ROW EXECUTE FUNCTION reject_trade_submit()",
  );
  try {
    expect((await execution(attempt)).status).toBe(500);
  } finally {
    await pg.exec("DROP TRIGGER reject_trade_submit ON trade_attempts; DROP FUNCTION reject_trade_submit()");
  }
  expect(requests.filter((request) => request.url.pathname.endsWith("/execute"))).toEqual([]);
  expect((await drizzle(pg).select().from(tradeAttempts))[0]?.status).toBe("prepared");
  expect((await execution(attempt)).status).toBe(200);
});

test("revoked sessions cannot prepare or mutate attempts", async () => {
  const { attempt } = await prepared();
  await auth.logout(hashSecret(tokenA));
  expect((await prepare()).status).toBe(401);
  expect((await execution(attempt)).status).toBe(401);
  expect(
    (
      await request("POST", `/${attempt.id}/wallet-rejection`, {
        quoteId: attempt.quoteId,
        requestId: attempt.requestId,
        reason: "USER_CANCELLED",
      })
    ).status,
  ).toBe(401);
  expect((await drizzle(pg).select().from(tradeAttempts))[0]?.status).toBe("prepared");
});

test("read-only status recovers a submitted Devnet signature without another broadcast", async () => {
  const id = crypto.randomUUID(),
    quoteId = crypto.randomUUID();
  await drizzle(pg).update(watchedWallets).set({ network: "devnet" }).where(eq(watchedWallets.id, walletId));
  await drizzle(pg).insert(tradeAttempts).values({
    id,
    network: "devnet",
    userId: ownerA,
    signalId,
    quoteId,
    requestId: "recover-devnet",
    taker: wallet.publicKey.toBase58(),
    router: "pumpswap",
    inputAmountLamports: 10_000_000n,
    status: "submitted",
    signature: signedSignature,
  });
  let checks = 0;
  const provider = {
    async getRealOrder(): Promise<never> {
      throw new Error("Must not prepare during recovery");
    },
    async execute(): Promise<never> {
      throw new Error("Must not broadcast during recovery");
    },
    async getExecution(signature: string) {
      checks++;
      expect(signature).toBe(signedSignature);
      return {
        status: "confirmed" as const,
        requestId: "recover-devnet",
        code: 0 as const,
        signature,
        totalInputAmountRaw: "9000000",
        inputAmountResultRaw: "9000000",
        totalOutputAmountRaw: "1000",
        outputAmountResultRaw: "1000",
      };
    },
  };
  const service = createTradeAttemptService(auth, provider, () => clock, undefined, "devnet");
  await expect(service.get(hashSecret(tokenB), id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(checks).toBe(0);
  expect((await service.get(hashSecret(tokenA), id)).status).toBe("confirmed");
  expect((await service.get(hashSecret(tokenA), id)).status).toBe("confirmed");
  expect(checks).toBe(1);
});
