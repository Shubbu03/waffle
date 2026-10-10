import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createAuthStore, createReadStore, createSubscriptionStore, type DatabaseTransaction } from "@waffle/db";
import { userWalletSubscriptions } from "@waffle/db/schema";
import {
  apiErrorSchema,
  PUMP_SWAP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  signalDetailSchema,
  signalPageSchema,
  WRAPPED_SOL_MINT,
  walletSubscriptionSchema,
  walletSubscriptionsResponseSchema,
} from "@waffle/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";

let pg: PGlite;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const walletA = "33333333-3333-4333-8333-333333333333";
const walletB = "44444444-4444-4444-8444-444444444444";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE subscription_test_login`);
    return run(tx);
  });
const auth = createAuthStore(transaction);
const reads: ReturnType<typeof createReadStore> = {
  wallets: () => transaction((tx) => createReadStore(tx).wallets()),
  signals: (input, ownerId) => transaction((tx) => createReadStore(tx).signals(input, ownerId)),
  signal: (id) => transaction((tx) => createReadStore(tx).signal(id)),
};
const app = createApp({ reads, async ping() {} }, { store: auth, uri: "https://waffle.example" });

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec(
    "CREATE ROLE subscription_test_login LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO subscription_test_login",
  );
  await pg.query(
    "INSERT INTO watched_wallets (id, address, label, inclusion_reason) VALUES ($1, $2, 'A', 'Reviewed'), ($3, $4, 'B', 'Reviewed')",
    [walletA, WRAPPED_SOL_MINT, walletB, SPL_TOKEN_PROGRAM_ID],
  );
});
beforeEach(async () => {
  await pg.exec("TRUNCATE users, signals CASCADE; UPDATE watched_wallets SET active = true");
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
});
afterAll(async () => {
  await pg?.close();
});

function request(method: string, path = "", body?: unknown, token: string | null = tokenA) {
  return app.request(`/wallet-subscriptions${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function follow(walletId = walletA, body: unknown = {}, token = tokenA) {
  const response = await request("PUT", `/${walletId}`, body, token);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return walletSubscriptionSchema.parse(await response.json());
}
async function list(token = tokenA) {
  const response = await request("GET", "", undefined, token);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return walletSubscriptionsResponseSchema.parse(await response.json());
}
async function assertError(response: Response, status: number) {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.requestId).toBe(response.headers.get("x-request-id") ?? undefined);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return body;
}

describe("follow and alert preferences", () => {
  test("lists only the current owner and defaults new follows to alerts off", async () => {
    expect(await list()).toEqual({ items: [] });
    const a = await follow();
    const b = await follow(walletB, { alertsEnabled: true }, tokenB);
    expect(a).toMatchObject({ walletId: walletA, alertsEnabled: false, alertsEnabledAt: null });
    expect(await list()).toEqual({ items: [a] });
    expect(await list(tokenB)).toEqual({ items: [b] });
    expect(await transaction((tx) => tx.select().from(userWalletSubscriptions))).toEqual([]);
  });

  test("repeated and overlapping follows are idempotent and preserve creation time", async () => {
    const results = await Promise.all([follow(), follow(), follow()]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(await follow(walletA, { alertsEnabled: false })).toEqual(results[0]);
    expect((await list()).items).toHaveLength(1);
    expect((await pg.query("SELECT * FROM user_wallet_subscriptions")).rows).toHaveLength(1);
  });

  test("alert opt-in time changes only on off-to-on transitions and is never supplied by the client", async () => {
    const created = await follow();
    const enabled = await follow(walletA, { alertsEnabled: true });
    expect(enabled.alertsEnabled).toBe(true);
    expect(enabled.alertsEnabledAt).not.toBeNull();
    expect(enabled.createdAt).toBe(created.createdAt);
    const oldOptIn = "2020-01-01T00:00:00Z";
    await pg.query("UPDATE user_wallet_subscriptions SET alerts_enabled_at = $1 WHERE user_id = $2", [
      oldOptIn,
      ownerA,
    ]);
    const old = (await list()).items[0];
    if (!old) throw new Error("Expected existing follow");
    expect(await follow()).toEqual(old);
    expect(await follow(walletA, { alertsEnabled: true })).toEqual(old);
    const disabled = await follow(walletA, { alertsEnabled: false });
    expect(disabled.alertsEnabledAt).toBeNull();
    expect(disabled.alertsEnabled).toBe(false);
    const reenabled = await follow(walletA, { alertsEnabled: true });
    expect(Date.parse(reenabled.alertsEnabledAt ?? "")).toBeGreaterThan(Date.parse(oldOptIn));
    expect(reenabled.createdAt).toBe(created.createdAt);
    await assertError(await request("PUT", `/${walletA}`, { alertsEnabled: true, alertsEnabledAt: oldOptIn }), 400);
  });

  test("explicit initial opt-in is supported and retry never renews its timestamp", async () => {
    const first = await follow(walletA, { alertsEnabled: true });
    expect(first.alertsEnabledAt).not.toBeNull();
    expect(await follow()).toEqual(first);
    expect(await follow(walletA, { alertsEnabled: true })).toEqual(first);
  });

  test("unknown catalog wallets cannot be followed and unfollow is idempotent", async () => {
    const missing = crypto.randomUUID();
    expect((await assertError(await request("PUT", `/${missing}`, {}), 404)).error.code).toBe("NOT_FOUND");
    expect((await request("DELETE", `/${missing}`)).status).toBe(204);
    await follow();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request("DELETE", `/${walletA}`);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect((await list()).items).toEqual([]);
    expect(await follow()).toMatchObject({ alertsEnabled: false, alertsEnabledAt: null });
  });

  test("paused wallets reject new follows and new alert opt-ins but permit existing no-ops, mute and unfollow", async () => {
    const existing = await follow();
    const optedIn = await follow(walletB, { alertsEnabled: true });
    await pg.exec("UPDATE watched_wallets SET active = false");
    for (const body of [{}, { alertsEnabled: false }, { alertsEnabled: true }]) {
      expect((await assertError(await request("PUT", `/${walletA}`, body, tokenB), 409)).error.code).toBe("CONFLICT");
    }
    expect(await follow()).toEqual(existing);
    expect(await follow(walletA, { alertsEnabled: false })).toEqual(existing);
    await assertError(await request("PUT", `/${walletA}`, { alertsEnabled: true }), 409);
    expect(await follow(walletB, { alertsEnabled: true })).toEqual(optedIn);
    expect(await follow(walletB, { alertsEnabled: false })).toMatchObject({
      alertsEnabled: false,
      alertsEnabledAt: null,
    });
    await assertError(await request("PUT", `/${walletB}`, { alertsEnabled: true }), 409);
    expect((await list()).items).toHaveLength(2);
    expect((await list(tokenB)).items).toEqual([]);
    expect((await request("DELETE", `/${walletA}`)).status).toBe(204);
    await pg.query("UPDATE watched_wallets SET active = true WHERE id = $1", [walletA]);
    expect(await follow(walletA, { alertsEnabled: true })).toMatchObject({ alertsEnabled: true });
  });
});

describe("subscription access boundaries", () => {
  test("anonymous, malformed, expired and revoked sessions cannot list, follow or unfollow", async () => {
    const existing = await follow();
    for (const token of [null, "invalid", "c".repeat(43)]) {
      await assertError(await request("GET", "", undefined, token), 401);
      await assertError(await request("PUT", `/${walletA}`, {}, token), 401);
      await assertError(await request("DELETE", `/${walletA}`, undefined, token), 401);
    }
    expect((await list()).items).toEqual([existing]);
    await pg.query(
      "UPDATE sessions SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE user_id = $1",
      [ownerA],
    );
    await pg.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [ownerB]);
    for (const token of [tokenA, tokenB]) {
      await assertError(await request("GET", "", undefined, token), 401);
      await assertError(await request("PUT", `/${walletB}`, { alertsEnabled: true }, token), 401);
      await assertError(await request("DELETE", `/${walletA}`, undefined, token), 401);
    }
    expect((await pg.query("SELECT user_id FROM user_wallet_subscriptions")).rows).toEqual([{ user_id: ownerA }]);
  });

  test("rejects owner injection, malformed IDs, extra fields and invalid JSON without mutations", async () => {
    for (const body of [
      { userId: ownerB },
      { walletId: walletB },
      { alertsEnabled: "true" },
      { alertsEnabled: null },
      { createdAt: "2020-01-01" },
      [],
    ]) {
      await assertError(await request("PUT", `/${walletA}`, body), 400);
    }
    for (const method of ["PUT", "DELETE"]) {
      await assertError(await request(method, "/bad-id", method === "PUT" ? {} : undefined), 400);
      await assertError(await request(method, `/${walletA}?userId=${ownerB}`, method === "PUT" ? {} : undefined), 400);
    }
    await assertError(await request("GET", `?userId=${ownerB}`), 400);
    await assertError(await request("GET", "?limit=1&limit=2"), 400);
    await assertError(
      await app.request(`/wallet-subscriptions/${walletA}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: "{",
      }),
      400,
    );
    await assertError(
      await app.request(`/wallet-subscriptions/${walletA}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "text/plain" },
        body: "{}",
      }),
      415,
    );
    await assertError(await request("PUT", `/${walletA}`, { value: "x".repeat(5000) }), 413);
    expect((await list()).items).toEqual([]);
  });

  test("RLS independently denies operations using another user's ID and owner transactions roll back", async () => {
    const b = await follow(walletA, { alertsEnabled: true }, tokenB);
    expect(
      await auth.withSession(hashSecret(tokenA), (query) => createSubscriptionStore(query, ownerB).list()),
    ).toEqual({ items: [] });
    await expect(
      auth.withSession(hashSecret(tokenA), (query) => createSubscriptionStore(query, ownerB).put(walletA, {})),
    ).rejects.toThrow();
    await auth.withSession(hashSecret(tokenA), (query) => createSubscriptionStore(query, ownerB).remove(walletA));
    expect((await list(tokenB)).items).toEqual([b]);
    await expect(
      auth.withSession(hashSecret(tokenA), async (query) => {
        await createSubscriptionStore(query, ownerA).put(walletA, {});
        throw new Error("Abort follow");
      }),
    ).rejects.toThrow("Abort follow");
    expect((await list()).items).toEqual([]);
    expect(await transaction((tx) => tx.select().from(userWalletSubscriptions))).toEqual([]);
  });
});

test("unfollowing preserves shared signals, catalog monitoring and another user's subscriptions", async () => {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const signalId = crypto.randomUUID();
  const scored = scoreSignal({
    mintAddress: SPL_TOKEN_PROGRAM_ID,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: 100,
    currentSlot: 101,
    observedAtMs: now,
    nowMs: now,
    mint: null,
    pool: null,
    quote: null,
    holders: null,
    creator: null,
    oracle: null,
  });
  const snapshot = {
    transactionSlot: 100,
    currentSlot: 101,
    mint: null,
    pool: null,
    quote: null,
    holders: null,
    creator: null,
    oracle: null,
  };
  await pg.query(
    `INSERT INTO signals (id, signature, wallet_id, mint_address, source_program_id, slot, observed_at,
    score_version, score, status, data_status, reasons, snapshot)
    VALUES ($1, $2, $3, $4, $5, 100, $6, 1, $7, $8, 'unknown', $9, $10)`,
    [
      signalId,
      "1".repeat(64),
      walletA,
      SPL_TOKEN_PROGRAM_ID,
      PUMP_SWAP_PROGRAM_ID,
      iso,
      scored.score,
      scored.status,
      JSON.stringify(scored.reasons),
      JSON.stringify(snapshot),
    ],
  );
  await pg.query("INSERT INTO signal_events (signal_id) VALUES ($1)", [signalId]);
  await follow();
  const other = await follow(walletA, { alertsEnabled: true }, tokenB);
  const before = signalDetailSchema.parse(await (await app.request(`/signals/${signalId}`)).json());
  const feed = async (token: string) =>
    signalPageSchema.parse(
      await (await app.request("/signals?view=following", { headers: { authorization: `Bearer ${token}` } })).json(),
    );
  expect((await feed(tokenA)).items).toHaveLength(1);
  expect((await feed(tokenB)).items).toHaveLength(1);
  await request("DELETE", `/${walletA}`);
  expect((await list()).items).toEqual([]);
  expect((await list(tokenB)).items).toEqual([other]);
  expect((await feed(tokenA)).items).toEqual([]);
  expect((await feed(tokenB)).items[0]?.id).toBe(signalId);
  expect(signalPageSchema.parse(await (await app.request("/signals")).json()).items[0]?.id).toBe(signalId);
  expect(signalDetailSchema.parse(await (await app.request(`/signals/${signalId}`)).json())).toEqual(before);
  expect((await pg.query("SELECT active FROM watched_wallets WHERE id = $1", [walletA])).rows).toEqual([
    { active: true },
  ]);
});
