import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createAuthStore, createPaperPositionStore, type DatabaseTransaction } from "@waffle/db";
import { paperPositions, sessions, signalEvents, signals, users, watchedWallets } from "@waffle/db/schema";
import type { HttpTransport } from "@waffle/http";
import {
  type ApiErrorCode,
  apiErrorSchema,
  PUMP_SWAP_PROGRAM_ID,
  paperPositionsResponseSchema,
  paperPositionWithFillSchema,
  paperQuoteSchema,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";
import { JupiterService } from "../src/jupiter.ts";

let pg: PGlite;
let clock: number;
let calls: URL[];
let upstream: Record<string, unknown>;
let afterFetch: () => Promise<void>;
let app: ReturnType<typeof createApp>;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const walletId = "33333333-3333-4333-8333-333333333333";
const signalId = "44444444-4444-4444-8444-444444444444";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const sizeLamports = "100000000";
const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE paper_test_login`);
    return run(tx);
  });
const auth = createAuthStore(transaction);

beforeAll(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec("CREATE ROLE paper_test_login LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO paper_test_login");
  await drizzle(pg)
    .insert(watchedWallets)
    .values({ id: walletId, address: WRAPPED_SOL_MINT, label: "Test", inclusionReason: "Test" });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  clock = Date.now();
  calls = [];
  afterFetch = async () => {};
  await pg.exec("TRUNCATE users, signals CASCADE");
  const db = drizzle(pg);
  await db.insert(users).values([
    { id: ownerA, walletAddress: WRAPPED_SOL_MINT },
    { id: ownerB, walletAddress: SPL_TOKEN_PROGRAM_ID },
  ]);
  await db.insert(sessions).values([
    { userId: ownerA, tokenHash: hashSecret(tokenA), expiresAt: new Date(clock + 60_000) },
    { userId: ownerB, tokenHash: hashSecret(tokenB), expiresAt: new Date(clock + 60_000) },
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
  upstream = {
    inputMint: WRAPPED_SOL_MINT,
    outputMint: PUMP_SWAP_PROGRAM_ID,
    inAmount: sizeLamports,
    outAmount: "9007199254740993123",
    otherAmountThreshold: "8556839292003943467",
    requestId: "provider-request",
    router: "metis",
    priceImpact: -0.5,
    slippageBps: 500,
    feeBps: 10,
    feeMint: PUMP_SWAP_PROGRAM_ID,
    platformFee: { amount: "2", feeBps: 10, feeMint: PUMP_SWAP_PROGRAM_ID },
    signatureFeeLamports: 5000,
    prioritizationFeeLamports: 1000,
    rentFeeLamports: 2000,
    taker: null,
    transaction: null,
  };
  const fakeTransport = (async (url: string | URL | Request) => {
    calls.push(new URL(String(url)));
    await afterFetch();
    return Response.json(upstream);
  }) as HttpTransport;
  app = createApp(
    { async ping() {} },
    { store: auth, uri: "https://waffle.example" },
    {
      jupiter: new JupiterService("test-secret", fakeTransport, () => clock),
      now: () => clock,
    },
  );
});
function request(method: string, path: string, body?: unknown, token: string | null = tokenA) {
  return app.request(`/paper-positions${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function quote(token = tokenA) {
  const response = await request("POST", "/quote", { signalId, sizeLamports }, token);
  expect(response.status).toBe(200);
  return paperQuoteSchema.parse(await response.json());
}
async function fill(quoteId: string, token = tokenA) {
  return request("POST", "", { signalId, quoteId, sizeLamports }, token);
}
async function error(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}
async function count() {
  return (await drizzle(pg).select().from(paperPositions)).length;
}

test("creates an exact simulated fill from a server quote and persists evidence and quote age", async () => {
  const q = await quote();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.searchParams.has("taker")).toBe(false);
  expect(calls[0]?.searchParams.get("outputMint")).toBe(PUMP_SWAP_PROGRAM_ID);
  clock += 1234;
  const response = await fill(q.id);
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const position = paperPositionWithFillSchema.parse(await response.json());
  expect(position).toMatchObject({
    simulated: true,
    status: "open",
    sizeLamports,
    entryQuote: q,
    fill: {
      outputAmountRaw: upstream.outAmount,
      minOutputAmountRaw: upstream.otherAmountThreshold,
      totalDebitLamports: "100008000",
      quoteAgeMs: 1234,
    },
  });
  const [stored] = await drizzle(pg).select().from(paperPositions);
  expect(stored?.entryQuote).toEqual(q);
  expect(stored?.createdAt.getTime()).toBe(clock);
  expect(paperPositionsResponseSchema.parse(await (await request("GET", "")).json()).items).toEqual([position]);
  expect(calls.every((url) => url.pathname.endsWith("/order"))).toBe(true);
  await error(await fill(q.id), 409, "QUOTE_UNAVAILABLE");
  expect(await count()).toBe(1);
});

test("requires valid sessions before provider access and isolates quotes and positions by owner", async () => {
  for (const token of [null, "bad", "c".repeat(43)]) {
    await error(await request("POST", "/quote", { signalId, sizeLamports }, token), 401, "UNAUTHORIZED");
    await error(await request("GET", "", undefined, token), 401, "UNAUTHORIZED");
  }
  expect(calls).toHaveLength(0);
  const q = await quote();
  await error(await fill(q.id, tokenB), 409, "QUOTE_UNAVAILABLE");
  const created = paperPositionWithFillSchema.parse(await (await fill(q.id)).json());
  expect(paperPositionsResponseSchema.parse(await (await request("GET", "", undefined, tokenB)).json()).items).toEqual(
    [],
  );
  await error(await request("GET", `?cursor=${created.id}`, undefined, tokenB), 404, "NOT_FOUND");
  expect(await transaction((tx) => tx.select().from(paperPositions))).toEqual([]);
  expect(
    await auth.withSession(hashSecret(tokenB), (tx) => createPaperPositionStore(tx, ownerA).list({ limit: 50 })),
  ).toEqual({ items: [], nextCursor: null });
  await expect(
    auth.withSession(hashSecret(tokenB), (tx) => createPaperPositionStore(tx, ownerA).create(q, clock)),
  ).rejects.toThrow();
});

test("rejects stale or missing quotes, size/signal mismatches, and duplicate concurrent fills", async () => {
  await error(await fill(crypto.randomUUID()), 409, "QUOTE_UNAVAILABLE");
  const q = await quote();
  await error(await request("POST", "", { signalId, quoteId: q.id, sizeLamports: "1" }), 409, "CONFLICT");
  await error(
    await request("POST", "", { signalId: crypto.randomUUID(), quoteId: q.id, sizeLamports }),
    409,
    "CONFLICT",
  );
  const results = await Promise.all([fill(q.id), fill(q.id)]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const stale = await quote();
  clock += 10_000;
  await error(await fill(stale.id), 409, "QUOTE_UNAVAILABLE");
  expect(await count()).toBe(1);
});

test("rejects stale signals/liquidity before quoting and rechecks after provider latency", async () => {
  clock += 90_001;
  await error(await request("POST", "/quote", { signalId, sizeLamports }), 409, "STALE_SIGNAL");
  expect(calls).toHaveLength(0);
  clock -= 90_001;
  clock += 15_001;
  await error(await request("POST", "/quote", { signalId, sizeLamports }), 409, "STALE_SIGNAL");
  clock -= 15_001;
  clock += 9_000;
  afterFetch = async () => {
    clock += 7_000;
  };
  await error(await request("POST", "/quote", { signalId, sizeLamports }), 409, "STALE_SIGNAL");
  expect(await count()).toBe(0);
});

test("logout during quote acquisition prevents issuance and revoked/expired sessions cannot fill", async () => {
  const q = await quote();
  afterFetch = async () => {
    await auth.logout(hashSecret(tokenA));
  };
  await error(await request("POST", "/quote", { signalId, sizeLamports }), 401, "UNAUTHORIZED");
  await error(await fill(q.id), 401, "UNAUTHORIZED");
  await drizzle(pg)
    .update(sessions)
    .set({ createdAt: new Date(clock - 10000), expiresAt: new Date(clock - 1) })
    .where(eq(sessions.userId, ownerB));
  await error(await request("GET", "", undefined, tokenB), 401, "UNAUTHORIZED");
  expect(await count()).toBe(0);
});

test("rejects untrusted owner, quote, fill, amount, and query fields", async () => {
  for (const body of [
    { signalId, sizeLamports: "100000001" },
    { signalId, sizeLamports: "0" },
    { signalId, sizeLamports: "-1" },
    { signalId, sizeLamports: 1 },
    { signalId: "' OR 1=1--", sizeLamports },
    { signalId, sizeLamports, userId: ownerB },
    { signalId, sizeLamports, outputMint: WRAPPED_SOL_MINT },
  ]) {
    await error(await request("POST", "/quote", body), 400, "VALIDATION_ERROR");
  }
  const q = await quote();
  for (const extra of [{ userId: ownerB }, { entryQuote: q }, { simulated: false }, { fill: {} }]) {
    await error(
      await request("POST", "", { signalId, sizeLamports, quoteId: q.id, ...extra }),
      400,
      "VALIDATION_ERROR",
    );
  }
  for (const path of ["?limit=51", "?limit=0", "?limit=1&limit=2", `?userId=${ownerB}`, "?cursor=bad"]) {
    await error(await request("GET", path), 400, "VALIDATION_ERROR");
  }
  await error(
    await app.request("/paper-positions", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: "{",
    }),
    400,
    "VALIDATION_ERROR",
  );
  expect(await count()).toBe(0);
});

test("malformed upstream quotes and missing provider configuration fail without a position", async () => {
  for (const update of [
    { outAmount: "0" },
    { outputMint: WRAPPED_SOL_MINT },
    { transaction: "untrusted" },
    { inAmount: "1" },
  ]) {
    const original = { ...upstream };
    Object.assign(upstream, update);
    await error(await request("POST", "/quote", { signalId, sizeLamports }), 503, "QUOTE_UNAVAILABLE");
    upstream = original;
  }
  const noProvider = createApp(
    { async ping() {} },
    { store: auth, uri: "https://waffle.example" },
    { now: () => clock },
  );
  await error(
    await noProvider.request("/paper-positions/quote", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ signalId, sizeLamports }),
    }),
    503,
    "SERVICE_UNAVAILABLE",
  );
  expect(await count()).toBe(0);
});

test("lists only the owner in stable pages, including equal timestamps", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++)
    ids.push(paperPositionWithFillSchema.parse(await (await fill((await quote()).id)).json()).id);
  await fill((await quote(tokenB)).id, tokenB);
  const first = paperPositionsResponseSchema.parse(await (await request("GET", "?limit=2")).json());
  expect(first.items.map((p) => p.id)).toEqual(ids.sort().reverse().slice(0, 2));
  const second = paperPositionsResponseSchema.parse(
    await (await request("GET", `?limit=2&cursor=${first.nextCursor}`)).json(),
  );
  expect(second.items.map((p) => p.id)).toEqual(ids.slice(2));
  expect(second.nextCursor).toBeNull();
});

test("database failure rolls back and makes an unexpired quote retryable", async () => {
  const q = await quote();
  await pg.exec(`CREATE FUNCTION fail_paper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database detail'; END $$;
    CREATE TRIGGER fail_paper BEFORE INSERT ON paper_positions FOR EACH ROW EXECUTE FUNCTION fail_paper()`);
  try {
    await error(await fill(q.id), 500, "INTERNAL_ERROR");
    expect(await count()).toBe(0);
  } finally {
    await pg.exec("DROP TRIGGER fail_paper ON paper_positions; DROP FUNCTION fail_paper()");
  }
  expect((await fill(q.id)).status).toBe(201);
});

test("fill rechecks liquidity freshness and rejects signals without trusted transaction timing", async () => {
  clock += 9_000;
  const q = await quote();
  clock += 7_000;
  await error(await fill(q.id), 409, "STALE_SIGNAL");
  expect(await count()).toBe(0);
  clock -= 16_000;
  const [row] = await drizzle(pg).select().from(signals).where(eq(signals.id, signalId));
  if (!row) throw new Error("Expected signal");
  const snapshot = structuredClone(row.snapshot);
  delete snapshot.assessment;
  await drizzle(pg).update(signals).set({ snapshot }).where(eq(signals.id, signalId));
  await error(await request("POST", "/quote", { signalId, sizeLamports }), 409, "STALE_SIGNAL");
  await error(await request("POST", "/quote", { signalId: crypto.randomUUID(), sizeLamports }), 404, "NOT_FOUND");
  expect(await count()).toBe(0);
});

test("quote lookup and position detail are owner-only, including unknown quote IDs", async () => {
  const q = await quote();
  expect(await (await request("GET", `/by-quote/${q.id}`)).json()).toEqual({ position: null });
  const position = paperPositionWithFillSchema.parse(await (await fill(q.id)).json());
  expect(await (await request("GET", `/by-quote/${q.id}`)).json()).toEqual({ position });
  expect(await (await request("GET", `/by-quote/${q.id}`, undefined, tokenB)).json()).toEqual({ position: null });
  expect(await (await request("GET", `/${position.id}`)).json()).toEqual(position);
  await error(await request("GET", `/${position.id}`, undefined, tokenB), 404, "NOT_FOUND");
  for (const path of ["/by-quote/bad", "/bad/valuation", `/${position.id}?userId=${ownerB}`])
    await error(await request("GET", path), 400, "VALIDATION_ERROR");
  await error(await request("GET", `/by-quote/${q.id}`, undefined, null), 401, "UNAUTHORIZED");
});

async function filledPosition() {
  return paperPositionWithFillSchema.parse(await (await fill((await quote()).id)).json());
}
function exitQuote(quantity: string) {
  upstream = {
    ...upstream,
    inputMint: PUMP_SWAP_PROGRAM_ID,
    outputMint: WRAPPED_SOL_MINT,
    inAmount: quantity,
    outAmount: "110000000",
    otherAmountThreshold: "104500000",
  };
}
test("valuation quotes the exact held amount back to SOL without a taker, even after the signal ages", async () => {
  const position = await filledPosition();
  clock += 30_000;
  exitQuote(position.fill.outputAmountRaw);
  const response = await request("GET", `/${position.id}/valuation`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "available",
    positionId: position.id,
    quote: {
      inputAmountRaw: "9007199254740993123",
      outputLamports: "110000000",
      minOutputLamports: "104500000",
      feeLamports: "8000",
    },
  });
  const url = calls.at(-1);
  expect(url?.searchParams.get("inputMint")).toBe(PUMP_SWAP_PROGRAM_ID);
  expect(url?.searchParams.get("outputMint")).toBe(WRAPPED_SOL_MINT);
  expect(url?.searchParams.get("amount")).toBe(position.fill.outputAmountRaw);
  expect(url?.searchParams.has("taker")).toBe(false);
  expect(await count()).toBe(1);
});
test("foreign position valuation is blocked before provider I/O", async () => {
  const position = await filledPosition();
  const before = calls.length;
  await error(await request("GET", `/${position.id}/valuation`, undefined, tokenB), 404, "NOT_FOUND");
  expect(calls.length).toBe(before);
});
test("unavailable routes, mismatched amounts, transactions and expired exit quotes show no invented value", async () => {
  const position = await filledPosition();
  for (const update of [
    { outAmount: "0" },
    { inAmount: "1" },
    { inputMint: WRAPPED_SOL_MINT },
    { transaction: "unsafe" },
    { taker: WRAPPED_SOL_MINT },
    { expireAt: new Date(clock - 1).toISOString() },
  ]) {
    exitQuote(position.fill.outputAmountRaw);
    Object.assign(upstream, update);
    const response = await request("GET", `/${position.id}/valuation`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "unavailable", positionId: position.id });
    // Reset all mutated fields for the next case.
    delete upstream.expireAt;
    upstream.transaction = null;
    upstream.taker = null;
  }
  expect(await count()).toBe(1);
});
test("logout during valuation prevents a late response from disclosing the value", async () => {
  const position = await filledPosition();
  exitQuote(position.fill.outputAmountRaw);
  afterFetch = async () => {
    await drizzle(pg)
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashSecret(tokenA)));
  };
  await error(await request("GET", `/${position.id}/valuation`), 401, "UNAUTHORIZED");
});
test("paper quotes retain verified mint decimals without imposing defaults on old signals", async () => {
  expect((await quote()).outputDecimals).toBeUndefined();
  const [row] = await drizzle(pg).select().from(signals).where(eq(signals.id, signalId));
  if (!row?.snapshot.mint) throw new Error("Expected mint evidence");
  const snapshot = structuredClone(row.snapshot);
  if (snapshot.mint) snapshot.mint.decimals = 6;
  await drizzle(pg).update(signals).set({ snapshot }).where(eq(signals.id, signalId));
  const q = await quote();
  expect(q.outputDecimals).toBe(6);
  expect(paperPositionWithFillSchema.parse(await (await fill(q.id)).json()).entryQuote.outputDecimals).toBe(6);
});
