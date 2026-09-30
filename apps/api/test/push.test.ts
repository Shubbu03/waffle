import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createAuthStore,
  createPushDeliveryStore,
  type DatabaseTransaction,
  type PushMessage,
  type PushSendResult,
} from "@waffle/db";
import {
  pushDeliveries,
  pushTokens,
  sessions,
  signalEvents,
  signals,
  users,
  userWalletSubscriptions,
  watchedWallets,
} from "@waffle/db/schema";
import { createLogger } from "@waffle/observability";
import {
  PUMP_SWAP_PROGRAM_ID,
  pushTokenResponseSchema,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";
import { PushDelivery } from "../src/push-delivery.ts";

let pg: PGlite;
let clock: number;
let app: ReturnType<typeof createApp>;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const walletId = "33333333-3333-4333-8333-333333333333";
const signalId = "44444444-4444-4444-8444-444444444444";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE push_api_test`);
    return run(tx);
  });
const delivery: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE push_delivery_test`);
    return run(tx);
  });
const auth = createAuthStore(transaction);
const store = createPushDeliveryStore(
  delivery,
  () => clock,
  () => 0,
);
let sent: PushMessage[];
let result: PushSendResult;
const send = async (message: PushMessage) => {
  sent.push(message);
  return result;
};
const register = (token = "device-A", permission = "granted", bearer = tokenA, extras = {}) =>
  app.request("/push-tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token, platform: "android", notificationPermission: permission, ...extras }),
  });
const remove = (id: string, bearer = tokenA) =>
  app.request(`/push-tokens/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } });

beforeAll(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec(
    "CREATE ROLE push_api_test LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO push_api_test; CREATE ROLE push_delivery_test LOGIN INHERIT NOBYPASSRLS; GRANT waffle_delivery TO push_delivery_test",
  );
  await drizzle(pg)
    .insert(watchedWallets)
    .values({ id: walletId, address: WRAPPED_SOL_MINT, label: "Test", inclusionReason: "Test" });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  clock = Date.now();
  sent = [];
  result = { status: "sent" };
  await pg.exec("TRUNCATE users, signals CASCADE");
  const db = drizzle(pg);
  await db.update(watchedWallets).set({ active: true });
  await db.insert(users).values([
    { id: ownerA, walletAddress: WRAPPED_SOL_MINT },
    { id: ownerB, walletAddress: SPL_TOKEN_PROGRAM_ID },
  ]);
  await db.insert(sessions).values([
    { userId: ownerA, tokenHash: hashSecret(tokenA), expiresAt: new Date(clock + 60000) },
    { userId: ownerB, tokenHash: hashSecret(tokenB), expiresAt: new Date(clock + 60000) },
  ]);
  await db.insert(userWalletSubscriptions).values({
    userId: ownerA,
    watchedWalletId: walletId,
    alertsEnabled: true,
    createdAt: new Date(clock - 10000),
    alertsEnabledAt: new Date(clock - 10000),
  });
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
  await db.insert(signalEvents).values({ signalId, createdAt: new Date(clock + 1000) });
  clock += 1000;
  app = createApp({ async ping() {} }, { store: auth, uri: "https://waffle.example" });
});

test("registration is owner-bound, idempotent, permission-aware, and never returns tokens", async () => {
  const response = await register();
  expect(response.status).toBe(200);
  const first = pushTokenResponseSchema.parse(await response.json());
  expect(first).toMatchObject({ active: true, platform: "android", notificationPermission: "granted" });
  expect(first).not.toHaveProperty("token");
  expect(first).not.toHaveProperty("tokenHash");
  const [before] = await drizzle(pg).select().from(pushTokens);
  expect(await (await register()).json()).toEqual(first);
  const [after] = await drizzle(pg).select().from(pushTokens);
  expect(after?.updatedAt).toEqual(before?.updatedAt);
  expect((await register("device-A", "granted", tokenB)).status).toBe(409);
  expect((await register("device-A", "denied", tokenB)).status).toBe(409);
  await remove(first.id, tokenB);
  expect(await drizzle(pg).select().from(pushTokens)).toHaveLength(1);
  expect(await (await register("device-A", "denied")).json()).toMatchObject({ id: first.id, active: false });
  expect(await (await register()).json()).toMatchObject({ id: first.id, active: true });
  await remove(first.id);
  expect(await drizzle(pg).select().from(pushTokens)).toEqual([]);
});

test("registration rejects owner injection, malformed input, invalid sessions, and device overflow", async () => {
  expect((await register("device", "granted", tokenA, { userId: ownerB })).status).toBe(400);
  expect((await register("x'; DROP TABLE users; --")).status).toBe(400);
  expect((await register("device", "unknown")).status).toBe(400);
  expect((await register("device", "granted", "c".repeat(43))).status).toBe(401);
  const responses = await Promise.all(Array.from({ length: 11 }, (_, index) => register(`device-${index}`)));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
  expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
  await auth.logout(hashSecret(tokenA));
  expect((await register()).status).toBe(401);
  expect(await transaction((tx) => tx.select().from(pushTokens))).toEqual([]);
});

test("committed events expand once and send one compact data payload per opted-in device", async () => {
  await register();
  await register("other-owner", "granted", tokenB);
  await Promise.all([store.expandOne(), store.expandOne()]);
  await drizzle(pg).update(signalEvents).set({ pushExpandedAt: null });
  await store.expandOne();
  expect(await drizzle(pg).select().from(pushDeliveries)).toHaveLength(1);
  await Promise.all([store.deliverOne(send), store.deliverOne(send)]);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.data).toMatchObject({
    id: signalId,
    score: "80",
    wallet: WRAPPED_SOL_MINT,
    mint: PUMP_SWAP_PROGRAM_ID,
    slot: "100",
    age: "1",
  });
  expect(sent[0]?.expiresAt).toBe(clock + 89000);
  const [job] = await drizzle(pg).select().from(pushDeliveries);
  expect(job).toMatchObject({ status: "sent", attempts: 1, sentAt: new Date(clock) });
});

test.each([
  "muted",
  "unfollowed",
  "paused",
  "denied",
  "inactive",
  "stale",
  "suppressed",
  "historical",
  "critical-missing",
  "late-opt-in",
  "late-device",
])("%s does not expand alerts", async (state) => {
  await register();
  const db = drizzle(pg);
  if (state === "muted") await db.update(userWalletSubscriptions).set({ alertsEnabled: false, alertsEnabledAt: null });
  if (state === "unfollowed") await db.delete(userWalletSubscriptions);
  if (state === "paused") await db.update(watchedWallets).set({ active: false });
  if (state === "denied") await register("device-A", "denied");
  if (state === "inactive") await db.update(pushTokens).set({ active: false });
  if (state === "stale") clock += 90000;
  if (state === "suppressed" || state === "historical") {
    const [signal] = await db.select().from(signals);
    if (!signal) throw new Error("Expected signal");
    const reasons = signal.reasons.map((reason) =>
      state === "suppressed" && reason.code === "mint_safe"
        ? { code: "mint_unavailable_or_unsafe" as const, points: 0 }
        : state === "historical" && reason.code === "fresh_signal"
          ? { code: "stale_signal" as const, points: 0 }
          : reason,
    );
    await db.update(signals).set({
      status: state === "suppressed" ? "suppressed" : "history-only",
      reasons,
      score: reasons.reduce((sum, reason) => sum + reason.points, 0),
    });
  }
  if (state === "critical-missing")
    await db.update(signals).set({ snapshot: sql`jsonb_set(snapshot, '{mint}', 'null'::jsonb)` });
  if (state === "late-opt-in") await db.update(userWalletSubscriptions).set({ alertsEnabledAt: new Date(clock + 1) });
  if (state === "late-device") await db.update(pushTokens).set({ updatedAt: new Date(clock + 1) });
  await store.expandOne();
  await store.deliverOne(send);
  expect(sent).toEqual([]);
  expect(await drizzle(pg).select().from(pushDeliveries)).toEqual([]);
  expect((await drizzle(pg).select().from(signalEvents))[0]?.pushExpandedAt).not.toBeNull();
});

test.each(["muted", "unfollowed", "paused", "permission-revoked", "permission-reenabled", "stale"])(
  "%s after expansion cancels pending work",
  async (state) => {
    await register();
    await store.expandOne();
    expect(await drizzle(pg).select().from(pushDeliveries)).toHaveLength(1);
    const db = drizzle(pg);
    if (state === "muted")
      await db.update(userWalletSubscriptions).set({ alertsEnabled: false, alertsEnabledAt: null });
    if (state === "unfollowed") await db.delete(userWalletSubscriptions);
    if (state === "paused") await db.update(watchedWallets).set({ active: false });
    if (state === "permission-revoked") await register("device-A", "denied");
    if (state === "permission-reenabled") await db.update(pushTokens).set({ updatedAt: new Date(clock + 1) });
    if (state === "stale") clock += 90000;
    await store.deliverOne(send);
    expect(sent).toEqual([]);
    expect((await db.select().from(pushDeliveries))[0]?.status).toBe("disabled");
  },
);

test("invalid tokens are disabled while another device remains registered", async () => {
  await register();
  await register("device-B");
  await store.expandOne();
  result = { status: "invalid-token", code: "FCM_INVALID_TOKEN" };
  await store.deliverOne(send);
  const tokens = await drizzle(pg).select().from(pushTokens);
  expect(tokens.filter((token) => token.active)).toHaveLength(1);
  expect(tokens.find((token) => token.token === sent[0]?.token)?.active).toBe(false);
});

test("retry state survives worker recreation, respects Retry-After, and stops at expiry", async () => {
  await register();
  await store.expandOne();
  result = { status: "retry", code: "FCM_HTTP_429", retryAfterMs: 60000 };
  await store.deliverOne(send);
  const [job] = await drizzle(pg).select().from(pushDeliveries);
  expect(job).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: new Date(clock + 60000) });
  const restarted = createPushDeliveryStore(
    delivery,
    () => clock,
    () => 0,
  );
  await restarted.deliverOne(send);
  expect(sent).toHaveLength(1);
  clock += 60000;
  await restarted.deliverOne(send);
  expect(sent).toHaveLength(2);
  expect((await drizzle(pg).select().from(pushDeliveries))[0]?.status).toBe("failed");
});

test("transient transport failures back off exponentially with a finite attempt cap", async () => {
  await register();
  await store.expandOne();
  const transportFailure = async (): Promise<PushSendResult> => {
    throw new Error("private token or provider error");
  };
  for (const delay of [10000, 20000, 40000]) {
    await store.deliverOne(transportFailure);
    const [job] = await drizzle(pg).select().from(pushDeliveries);
    expect(job).toMatchObject({
      status: "pending",
      lastError: "TRANSPORT_ERROR",
      nextAttemptAt: new Date(clock + delay),
    });
    clock += delay;
  }
  await store.deliverOne(transportFailure);
  expect((await drizzle(pg).select().from(pushDeliveries))[0]).toMatchObject({ status: "failed", attempts: 4 });
});

test("expansion failure rolls back both jobs and the outbox marker", async () => {
  await register();
  await pg.exec(
    "CREATE FUNCTION reject_push_expansion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER reject_push_expansion BEFORE UPDATE ON signal_events FOR EACH ROW EXECUTE FUNCTION reject_push_expansion()",
  );
  try {
    await expect(store.expandOne()).rejects.toThrow();
  } finally {
    await pg.exec("DROP TRIGGER reject_push_expansion ON signal_events; DROP FUNCTION reject_push_expansion()");
  }
  expect(await drizzle(pg).select().from(pushDeliveries)).toEqual([]);
  expect((await drizzle(pg).select().from(signalEvents))[0]?.pushExpandedAt).toBeNull();
  await store.expandOne();
  expect(await drizzle(pg).select().from(pushDeliveries)).toHaveLength(1);
});

test("a crash after provider acceptance leaves a retryable job with the same deduplication ID", async () => {
  await register();
  await store.expandOne();
  await pg.exec(
    "CREATE FUNCTION reject_push_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER reject_push_update BEFORE UPDATE ON push_deliveries FOR EACH ROW EXECUTE FUNCTION reject_push_update()",
  );
  try {
    await expect(store.deliverOne(send)).rejects.toThrow();
  } finally {
    await pg.exec("DROP TRIGGER reject_push_update ON push_deliveries; DROP FUNCTION reject_push_update()");
  }
  expect((await drizzle(pg).select().from(pushDeliveries))[0]).toMatchObject({ status: "pending", attempts: 0 });
  await store.deliverOne(send);
  expect(sent).toHaveLength(2);
  expect(sent[0]?.data.id).toBe(sent[1]?.data.id);
});

test("worker health reports authorization failures and recovers without losing pending jobs", async () => {
  const logs: Record<string, unknown>[] = [];
  await register();
  let available = false;
  const worker = new PushDelivery(
    store,
    {
      async prepare() {
        if (!available) throw new Error("private-key");
        return send;
      },
    },
    createLogger({ service: "api", write: (line) => logs.push(JSON.parse(line)) }),
  );
  app = createApp({ async ping() {} }, undefined, undefined, undefined, worker);
  await worker.tick();
  expect((await app.request("/health")).status).toBe(503);
  expect(await drizzle(pg).select().from(pushDeliveries)).toHaveLength(1);
  await worker.tick();
  expect(logs).toHaveLength(1);
  available = true;
  await worker.tick();
  expect((await app.request("/health")).status).toBe(200);
  expect(worker.status.accepted).toBe(1);
  expect(logs.map((log) => [log.event, log.component])).toEqual([
    ["dependency.failed", "api.push"],
    ["dependency.recovered", "api.push"],
  ]);
  expect(JSON.stringify(logs)).not.toContain("private-key");
  await worker.stop();
});
