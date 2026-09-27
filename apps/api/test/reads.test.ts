import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { type AuthTransaction, createAuthStore, createReadStore } from "@waffle/db";
import {
  type ApiErrorCode,
  apiErrorSchema,
  getSignalsQuerySchema,
  PUMP_SWAP_PROGRAM_ID,
  type ScoredSignal,
  SPL_TOKEN_PROGRAM_ID,
  scoredSignalSchema,
  scoreSignal,
  signalDetailSchema,
  signalPageSchema,
  WRAPPED_SOL_MINT,
  walletCatalogResponseSchema,
} from "@waffle/shared";
import bs58 from "bs58";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { CATALOG, seedCatalog } from "../../../packages/db/src/seeds/catalog.ts";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";

let pg: PGlite;
let wallets: { id: string; address: string }[];
let serial = 0;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const firstEvent = 9007199254740993n;
const mint = "8Vte25yt28L8BfLXm8DrzjSYEyaKX8yry6hRKRmX7FGd";
const now = 1_800_000_000_000;
const iso = new Date(now).toISOString();
const transaction: AuthTransaction = (run) =>
  pg.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE read_test_login");
    return run(
      async <T extends Record<string, unknown>>(text: string, parameters: string[] = []) =>
        (await tx.query<T>(text, parameters)).rows,
    );
  });
const auth = createAuthStore(transaction);
const reads = createReadStore((text, parameters) => transaction((query) => query(text, parameters)));
const app = createApp({ reads, async ping() {} }, { store: auth, uri: "https://waffle.example" });

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  const db = drizzle(pg);
  await migrate(db, { migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname });
  await seedCatalog(db);
  const first = await pg.query<{ id: string; address: string }>(
    "SELECT id, address FROM watched_wallets ORDER BY address",
  );
  await seedCatalog(db);
  wallets = (
    await pg.query<{ id: string; address: string }>("SELECT id, address FROM watched_wallets ORDER BY address")
  ).rows;
  expect(wallets).toEqual(first.rows);
  await pg.exec("CREATE ROLE read_test_login LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO read_test_login");
});
beforeEach(async () => {
  serial = 0;
  await pg.exec(
    "TRUNCATE signals, users CASCADE; UPDATE watched_wallets SET active = true, recent_supported_activity_at = NULL",
  );
  await pg.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2), ($3, $4)", [
    ownerA,
    WRAPPED_SOL_MINT,
    ownerB,
    SPL_TOKEN_PROGRAM_ID,
  ]);
  await pg.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')",
    [ownerA, hashSecret(tokenA), ownerB, hashSecret(tokenB)],
  );
  await pg.query("INSERT INTO user_wallet_subscriptions (user_id, watched_wallet_id) VALUES ($1, $2), ($3, $4)", [
    ownerA,
    wallets[0]?.id,
    ownerB,
    wallets[1]?.id,
  ]);
});
afterAll(async () => {
  await pg?.close();
});

async function insertSignal(
  walletIndex = 0,
  status: ScoredSignal["status"] = "eligible",
  event = firstEvent + BigInt(serial * 2),
  withEvent = true,
) {
  const wallet = wallets[walletIndex];
  if (!wallet) throw new Error("Missing catalog wallet");
  serial++;
  const currentSlot = status === "history-only" ? 10_000 : 101;
  const authority = status === "suppressed" ? wallet.address : null;
  const mintEvidence = {
    address: mint,
    tokenProgramId: SPL_TOKEN_PROGRAM_ID,
    mintAuthority: authority,
    freezeAuthority: null,
    fetchedAt: iso,
  };
  const pool = { baseMint: mint, quoteMint: WRAPPED_SOL_MINT, liquidityUsd: 100_000, fetchedAt: iso };
  const quote = {
    inputMint: WRAPPED_SOL_MINT,
    outputMint: mint,
    inputLamports: "50000000",
    outputAmountRaw: "18446744073709551615",
    fetchedAt: iso,
  };
  const result = scoreSignal({
    mintAddress: mint,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: 100,
    currentSlot,
    observedAtMs: now,
    nowMs: now,
    mint: { ...mintEvidence, fetchedAtMs: now },
    pool: { ...pool, fetchedAtMs: now },
    quote: { ...quote, inputLamports: 50_000_000n, outputAmountRaw: 18446744073709551615n, fetchedAtMs: now },
    holders: null,
    creator: null,
    oracle: null,
  });
  const fresh = { status: "fresh", expiresAt: new Date(now + 10_000).toISOString(), reason: null };
  const unknown = { status: "unknown", expiresAt: null, reason: "unavailable" };
  const signal = scoredSignalSchema.parse({
    signature: bs58.encode(Buffer.alloc(64, serial)),
    walletAddress: wallet.address,
    mintAddress: mint,
    sourceProgramId: PUMP_SWAP_PROGRAM_ID,
    slot: 100,
    observedAt: iso,
    scoreVersion: 1,
    score: result.score,
    status: result.status,
    dataStatus: status === "history-only" ? "stale" : "partial",
    reasons: [...result.reasons],
    snapshot: {
      transactionSlot: 100,
      currentSlot,
      mint: mintEvidence,
      pool,
      quote,
      holders: null,
      creator: null,
      oracle: null,
      assessment: {
        scoredAt: iso,
        transactionAt: iso,
        source: "backfill",
        streamStale: false,
        evidence: { mint: fresh, pool: fresh, quote: fresh, holders: unknown, creator: unknown, oracle: unknown },
      },
    },
  });
  const id = crypto.randomUUID();
  // Reverse timestamps deliberately: feed pagination must follow event IDs, never timestamps.
  await pg.query(
    `INSERT INTO signals (id, signature, wallet_id, mint_address, source_program_id, slot,
    observed_at, published_at, score_version, score, status, data_status, reasons, snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $13)`,
    [
      id,
      signal.signature,
      wallet.id,
      mint,
      signal.sourceProgramId,
      signal.slot,
      iso,
      new Date(now - serial * 1000).toISOString(),
      signal.score,
      signal.status,
      signal.dataStatus,
      JSON.stringify(signal.reasons),
      JSON.stringify(signal.snapshot),
    ],
  );
  if (withEvent) await pg.query("INSERT INTO signal_events (id, signal_id) VALUES ($1, $2)", [event.toString(), id]);
  return { id, eventId: event.toString(), signal, walletId: wallet.id };
}
async function page(query = "", token?: string) {
  const response = await app.request(`/signals${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(response.status).toBe(200);
  return signalPageSchema.parse(await response.json());
}
async function error(path: string, status: number, code: ApiErrorCode, token?: string) {
  const response = await app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.requestId).toBe(response.headers.get("x-request-id") ?? undefined);
}

describe("public wallet and signal reads", () => {
  test("serves the reviewed catalog idempotently, including paused status and activity", async () => {
    await pg.query("UPDATE watched_wallets SET active = false, recent_supported_activity_at = $1 WHERE id = $2", [
      iso,
      wallets[0]?.id,
    ]);
    const response = await app.request("/wallets");
    expect(response.status).toBe(200);
    const catalog = walletCatalogResponseSchema.parse(await response.json());
    expect(catalog.items).toHaveLength(CATALOG.length);
    for (const entry of CATALOG)
      expect(catalog.items.find((item) => item.address === entry.address)).toMatchObject(entry);
    const paused = catalog.items.find((item) => item.id === wallets[0]?.id);
    expect(paused?.active).toBe(false);
    expect(Date.parse(paused?.recentSupportedActivityAt ?? "")).toBe(now);
    expect(catalog.items.some((item) => item.recentSupportedActivityAt === null)).toBe(true);
  });

  test("returns empty history safely and excludes records with no committed outbox event", async () => {
    await insertSignal(0, "eligible", firstEvent, false);
    expect(await page()).toEqual({ view: "all", direction: "before", items: [], nextCursor: null, hasMore: false });
  });

  test("paginates before and after with exact bigint cursors, gaps and no duplicates", async () => {
    const a = await insertSignal();
    const b = await insertSignal(1, "suppressed");
    const c = await insertSignal(0, "history-only");
    const first = await page("?limit=2");
    expect(first.items.map((item) => item.id)).toEqual([c.id, b.id]);
    expect(first.nextCursor).toBe(b.eventId);
    expect(first.hasMore).toBe(true);
    const last = await page(`?limit=2&cursor=${first.nextCursor}`);
    expect(last.items.map((item) => item.id)).toEqual([a.id]);
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBe(a.eventId);
    expect((await page(`?cursor=${a.eventId}`)).items).toEqual([]);
    const after = await page(`?direction=after&cursor=${a.eventId}&limit=1`);
    expect(after.items.map((item) => item.id)).toEqual([b.id]);
    expect(after.hasMore).toBe(true);
    expect((await page(`?direction=after&cursor=${after.nextCursor}&limit=1`)).items.map((item) => item.id)).toEqual([
      c.id,
    ]);
    expect((await page(`?direction=after&cursor=${c.eventId}`)).items).toEqual([]);
    expect((await page("?direction=after&limit=2")).items.map((item) => item.id)).toEqual([a.id, b.id]);
    expect((await page(`?direction=after&cursor=${BigInt(a.eventId) + 1n}`)).items.map((item) => item.id)).toEqual([
      b.id,
      c.id,
    ]);
  });

  test("new events between history pages cannot duplicate or displace older results", async () => {
    const a = await insertSignal();
    const b = await insertSignal();
    const first = await page("?limit=1");
    const c = await insertSignal();
    expect(first.items[0]?.id).toBe(b.id);
    expect((await page(`?cursor=${first.nextCursor}&limit=1`)).items[0]?.id).toBe(a.id);
    expect((await page(`?direction=after&cursor=${b.eventId}`)).items[0]?.id).toBe(c.id);
  });

  test("filters by wallet before limiting and preserves paused wallet history", async () => {
    const a = await insertSignal();
    await insertSignal(1);
    const b = await insertSignal();
    await insertSignal(1);
    await pg.query("UPDATE watched_wallets SET active = false WHERE id = $1", [a.walletId]);
    const first = await page(`?walletId=${a.walletId}&limit=1`);
    expect(first.items.map((item) => item.id)).toEqual([b.id]);
    expect(first.hasMore).toBe(true);
    expect(
      (await page(`?walletId=${a.walletId}&limit=1&cursor=${first.nextCursor}`)).items.map((item) => item.id),
    ).toEqual([a.id]);
    expect((await page(`?walletId=${crypto.randomUUID()}`)).items).toEqual([]);
  });

  test("detail preserves reasons, status and full evidence including exact raw amounts", async () => {
    for (const status of ["eligible", "history-only", "suppressed"] as const) {
      const row = await insertSignal(0, status);
      const response = await app.request(`/signals/${row.id}`);
      expect(response.status).toBe(200);
      const detail = signalDetailSchema.parse(await response.json());
      expect(detail.status).toBe(status);
      expect(detail.reasons).toEqual(row.signal.reasons);
      expect(detail.snapshot).toEqual(row.signal.snapshot);
      expect(detail.eventId).toBe(row.eventId);
      expect(detail.score).toBe(row.signal.score);
      expect(detail.dataStatus).toBe(row.signal.dataStatus);
      expect(detail.walletAddress).toBe(row.signal.walletAddress);
    }
  });

  test("expired cursors use global retained history even when filters match nothing", async () => {
    const a = await insertSignal();
    await insertSignal(1);
    await pg.query("DELETE FROM signal_events WHERE id = $1", [a.eventId]);
    for (const direction of ["before", "after"]) {
      await error(`/signals?cursor=${a.eventId}&direction=${direction}`, 409, "CURSOR_EXPIRED");
      await error(`/signals?view=following&cursor=${a.eventId}&direction=${direction}`, 409, "CURSOR_EXPIRED", tokenA);
    }
    // A valid global cursor with no matching wallet is an empty page, not an expired cursor.
    expect((await page(`?walletId=${wallets[2]?.id}&cursor=${firstEvent + 2n}`)).items).toEqual([]);
    await pg.exec("TRUNCATE signal_events CASCADE");
    await error(`/signals?cursor=${a.eventId}&direction=after`, 409, "CURSOR_EXPIRED");
  });

  test("bounds page sizes and rejects malformed, repeated or unknown query parameters", async () => {
    for (const query of [
      "limit=0",
      "limit=51",
      "limit=-1",
      "limit=1.5",
      "limit=01",
      "limit=1&limit=2",
      "cursor=0",
      "cursor=01",
      "cursor=9223372036854775808",
      "cursor=1%20OR%201=1",
      "walletId=bad",
      "view=private",
      "direction=sideways",
      `userId=${ownerB}`,
    ]) {
      await error(`/signals?${query}`, 400, "VALIDATION_ERROR");
    }
    await error("/wallets?active=true", 400, "VALIDATION_ERROR");
    await error("/signals/not-a-uuid", 400, "VALIDATION_ERROR");
    await error(`/signals/${crypto.randomUUID()}`, 404, "NOT_FOUND");
    const row = await insertSignal();
    await error(`/signals/${row.id}?userId=${ownerB}`, 400, "VALIDATION_ERROR");
    expect(getSignalsQuerySchema.parse({}).limit).toBe(50);
  });

  test("invalid stored evidence fails closed without exposing its contents", async () => {
    const row = await insertSignal();
    await pg.query("UPDATE signals SET snapshot = $1 WHERE id = $2", [
      JSON.stringify({ secret: "never-return-this" }),
      row.id,
    ]);
    const response = await app.request(`/signals/${row.id}`);
    expect(response.status).toBe(500);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("never-return-this");
  });
});

describe("Following access", () => {
  test("uses the session owner and applies follows plus wallet filter before pagination", async () => {
    const a = await insertSignal();
    const b = await insertSignal(1);
    const c = await insertSignal();
    await insertSignal(1);
    await error("/signals?view=following", 401, "UNAUTHORIZED");
    await error("/signals?view=following", 401, "UNAUTHORIZED", "invalid");
    const first = await page("?view=following&limit=1", tokenA);
    expect(first.items.map((item) => item.id)).toEqual([c.id]);
    expect(first.hasMore).toBe(true);
    expect((await page(`?view=following&cursor=${first.nextCursor}`, tokenA)).items.map((item) => item.id)).toEqual([
      a.id,
    ]);
    expect(
      (await page(`?view=following&direction=after&cursor=${a.eventId}`, tokenA)).items.map((item) => item.id),
    ).toEqual([c.id]);
    expect((await page(`?view=following&walletId=${b.walletId}`, tokenA)).items).toEqual([]);
    expect(
      (await page(`?view=following&walletId=${b.walletId}&direction=after`, tokenB)).items.map((item) => item.walletId),
    ).toEqual([b.walletId, b.walletId]);
    await error(`/signals?view=following&userId=${ownerB}`, 400, "VALIDATION_ERROR", tokenA);
    const response = await app.request("/signals?view=following", { headers: { authorization: `Bearer ${tokenA}` } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await transaction((query) => query("SELECT * FROM user_wallet_subscriptions"))).toEqual([]);
    expect((await page()).items).toHaveLength(4);
  });

  test("follows work with alerts disabled, pausing preserves history, unfollowing affects only Following", async () => {
    const row = await insertSignal();
    await pg.query("UPDATE watched_wallets SET active = false WHERE id = $1", [row.walletId]);
    expect((await page("?view=following", tokenA)).items[0]?.id).toBe(row.id);
    await pg.query("DELETE FROM user_wallet_subscriptions WHERE user_id = $1", [ownerA]);
    expect((await page("?view=following", tokenA)).items).toEqual([]);
    expect((await page()).items[0]?.id).toBe(row.id);
    expect((await app.request(`/signals/${row.id}`)).status).toBe(200);
  });

  test("expired and revoked sessions cannot query Following while public reads remain available", async () => {
    await insertSignal();
    await pg.query(
      "UPDATE sessions SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE user_id = $1",
      [ownerA],
    );
    await pg.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [ownerB]);
    for (const token of [tokenA, tokenB]) {
      await error("/signals?view=following", 401, "UNAUTHORIZED", token);
      expect((await page("", token)).items).toHaveLength(1);
    }
  });
});
