import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createAuthStore,
  createLiveDispatchStore,
  createLiveReadStore,
  createReadStore,
  type DatabaseTransaction,
} from "@waffle/db";
import { sessions, signalEvents, signals, users, userWalletSubscriptions, watchedWallets } from "@waffle/db/schema";
import {
  type LiveServerEvent,
  liveServerEventSchema,
  PUMP_SWAP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { websocket } from "hono/bun";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";
import { LiveDelivery, type LiveTransport } from "../src/live-delivery.ts";

let pg: PGlite;
let live: LiveDelivery;
let now: number;
let sequence: bigint;
const first = 9007199254740993n;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const walletA = "33333333-3333-4333-8333-333333333333";
const walletB = "44444444-4444-4444-8444-444444444444";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE live_api_test`);
    return run(tx);
  });
const delivery: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE live_delivery_test`);
    return run(tx);
  });
const auth = createAuthStore(transaction);
const reads = { page: (cursor: string | null) => transaction((tx) => createLiveReadStore(tx).page(cursor)) };
const dispatch = {
  pending: () => delivery((tx) => createLiveDispatchStore(tx).pending()),
  markDispatched: (ids: bigint[]) => delivery((tx) => createLiveDispatchStore(tx).markDispatched(ids)),
};
function hub() {
  return new LiveDelivery({ auth, reads, dispatch, now: () => now });
}
beforeAll(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec(
    "CREATE ROLE live_api_test LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO live_api_test; CREATE ROLE live_delivery_test LOGIN INHERIT NOBYPASSRLS; GRANT waffle_delivery TO live_delivery_test",
  );
  await drizzle(pg)
    .insert(watchedWallets)
    .values([
      { id: walletA, address: WRAPPED_SOL_MINT, label: "A", inclusionReason: "test" },
      { id: walletB, address: SPL_TOKEN_PROGRAM_ID, label: "B", inclusionReason: "test" },
    ]);
});
beforeEach(async () => {
  await live?.stop();
  now = Date.now();
  sequence = first;
  await pg.exec("TRUNCATE users, signals CASCADE");
  const db = drizzle(pg);
  await db.insert(users).values([
    { id: ownerA, walletAddress: WRAPPED_SOL_MINT },
    { id: ownerB, walletAddress: SPL_TOKEN_PROGRAM_ID },
  ]);
  await db.insert(sessions).values([
    { userId: ownerA, tokenHash: hashSecret(tokenA), expiresAt: new Date(now + 60_000) },
    { userId: ownerB, tokenHash: hashSecret(tokenB), expiresAt: new Date(now + 60_000) },
  ]);
  await db.insert(userWalletSubscriptions).values([
    { userId: ownerA, watchedWalletId: walletA },
    { userId: ownerB, watchedWalletId: walletB },
  ]);
  live = hub();
});
afterAll(async () => {
  await live?.stop();
  await pg.close();
});

async function append(walletId = walletA) {
  const db = drizzle(pg);
  const id = crypto.randomUUID();
  const eventId = sequence++;
  // Compact delivery never exposes the raw snapshot; detail validation remains a separate API boundary.
  await db.transaction(async (tx) => {
    await tx.insert(signals).values({
      id,
      signature: id,
      walletId,
      mintAddress: PUMP_SWAP_PROGRAM_ID,
      sourceProgramId: PUMP_SWAP_PROGRAM_ID,
      slot: 1,
      observedAt: new Date(now),
      scoreVersion: 1,
      score: 0,
      status: "suppressed",
      dataStatus: "unknown",
      reasons: [],
      snapshot: sql`'{}'::jsonb`,
    });
    await tx.insert(signalEvents).values({ id: eventId, signalId: id });
  });
  return { eventId: eventId.toString(), signalId: id, walletId };
}
function socket(ip = "127.0.0.1", accepts = true) {
  const frames: LiveServerEvent[] = [];
  const closes: number[] = [];
  const transport: LiveTransport = {
    send: (frame) => {
      frames.push(liveServerEventSchema.parse(frame));
      return accepts;
    },
    close: (code) => {
      closes.push(code);
    },
  };
  const connection = live.connect(transport, ip);
  return { frames, closes, connection, transport };
}
async function subscribe(client: ReturnType<typeof socket>, cursor: string | null = null, token?: string) {
  if (!client.connection) throw new Error("Expected connection");
  await client.connection.receive(
    JSON.stringify(
      token
        ? { v: 1, type: "auth", view: "following", cursor, accessToken: token }
        : { v: 1, type: "subscribe", view: "all", cursor },
    ),
  );
}
function events(client: ReturnType<typeof socket>) {
  return client.frames.filter((frame) => frame.type === "signal");
}

test("public initial history is bounded and ordered; repeated scans deduplicate and record dispatch", async () => {
  const inserted = [];
  for (let i = 0; i < 60; i++) inserted.push(await append(i % 2 ? walletB : walletA));
  const client = socket();
  await subscribe(client);
  expect(events(client).map((event) => event.eventId)).toEqual(inserted.slice(-50).map((event) => event.eventId));
  expect(client.frames.at(-1)).toEqual({
    v: 1,
    type: "ready",
    view: "all",
    latestEventId: inserted.at(-1)?.eventId ?? null,
  });
  const next = await append();
  await live.tick();
  await live.tick();
  expect(events(client)).toHaveLength(51);
  expect(events(client).at(-1)).toMatchObject(next);
  expect(await dispatch.pending()).toEqual([]);
  expect(live.status.degraded).toBe(false);
});

test("restart and missed polling recover even events already marked dispatched", async () => {
  const initial = await append();
  const client = socket();
  await subscribe(client);
  client.connection?.close();
  const missed = [await append(), await append()];
  await live.tick();
  expect(await dispatch.pending()).toEqual([]);
  await live.stop();
  live = hub();
  const reconnect = socket();
  await subscribe(reconnect, initial.eventId);
  await live.tick();
  expect(events(reconnect).map((event) => event.signalId)).toEqual(missed.map((event) => event.signalId));
  expect(new Set(events(reconnect).map((event) => event.signalId)).size).toBe(2);
});

test("cursor recovery pages beyond 50 and includes an event arriving during catch-up", async () => {
  const initial = await append();
  const missed = [];
  for (let i = 0; i < 115; i++) missed.push(await append());
  const client = socket();
  await subscribe(client, initial.eventId);
  expect(events(client)).toHaveLength(50);
  expect(client.frames.some((frame) => frame.type === "ready")).toBe(false);
  missed.push(await append());
  await live.tick();
  await live.tick();
  expect(events(client).map((event) => event.eventId)).toEqual(missed.map((event) => event.eventId));
  expect(client.frames.at(-1)?.type).toBe("ready");
});

test("an initially empty stream catches every later event rather than truncating to recent history", async () => {
  const client = socket();
  await subscribe(client);
  expect(client.frames).toEqual([{ v: 1, type: "ready", view: "all", latestEventId: null }]);
  for (let i = 0; i < 65; i++) await append();
  await live.tick();
  await live.tick();
  expect(events(client)).toHaveLength(65);
});

test("Following uses current subscriptions even with alerts off, and unfollow stops delivery", async () => {
  const a = await append();
  const b = await append(walletB);
  const follower = socket();
  await subscribe(follower, null, tokenA);
  const other = socket("127.0.0.2");
  await subscribe(other, null, tokenB);
  expect(events(follower).map((event) => event.signalId)).toEqual([a.signalId]);
  expect(events(other).map((event) => event.signalId)).toEqual([b.signalId]);
  await auth.withSession(hashSecret(tokenA), (tx) =>
    tx.delete(userWalletSubscriptions).where(eq(userWalletSubscriptions.userId, ownerA)),
  );
  await append();
  const nextB = await append(walletB);
  await live.tick();
  expect(events(follower)).toHaveLength(1);
  expect(events(other).at(-1)?.signalId).toBe(nextB.signalId);
  const reconnect = socket("127.0.0.3");
  await subscribe(reconnect, a.eventId, tokenA);
  expect(events(reconnect)).toEqual([]);
});

test("revoked, expired and invalid sessions close without Following data", async () => {
  await append();
  const follower = socket();
  await subscribe(follower, null, tokenA);
  await auth.logout(hashSecret(tokenA));
  await append();
  await live.tick();
  expect(events(follower)).toHaveLength(1);
  expect(follower.closes).toEqual([1008]);
  const invalid = socket();
  await subscribe(invalid, null, "c".repeat(43));
  expect(events(invalid)).toEqual([]);
  expect(invalid.closes).toEqual([1008]);
  await drizzle(pg)
    .update(sessions)
    .set({ createdAt: new Date(now - 10000), expiresAt: new Date(now - 1) })
    .where(eq(sessions.userId, ownerB));
  const expired = socket();
  await subscribe(expired, null, tokenB);
  expect(expired.closes).toEqual([1008]);
});

test("expired and future cursors explicitly fail instead of claiming complete history", async () => {
  const old = await append();
  const retained = await append();
  await drizzle(pg)
    .delete(signalEvents)
    .where(eq(signalEvents.id, BigInt(old.eventId)));
  const client = socket();
  await subscribe(client, old.eventId);
  expect(client.frames).toEqual([{ v: 1, type: "gap", view: "all", oldestAvailableEventId: retained.eventId }]);
  expect(client.closes).toEqual([1008]);
  const future = socket();
  await subscribe(future, (sequence + 100n).toString());
  expect(future.frames[0]).toMatchObject({ type: "error", error: { code: "VALIDATION_ERROR" } });
});

test("bounds connections and frames, times out authentication, and closes slow consumers", async () => {
  const clients = Array.from({ length: 5 }, () => socket());
  expect(clients[4]?.connection).toBeNull();
  expect(clients[4]?.closes).toEqual([1013]);
  now += 5000;
  await live.tick();
  expect(live.status.connections).toBe(0);
  for (const data of [
    "{",
    "x".repeat(2049),
    new Uint8Array([1]),
    JSON.stringify({ v: 1, type: "subscribe", view: "following", cursor: null }),
  ]) {
    const invalid = socket("invalid");
    await invalid.connection?.receive(data);
    expect(invalid.closes).toEqual([1008]);
  }
  await append();
  const slow = socket("slow", false);
  await subscribe(slow);
  expect(slow.closes).toEqual([1013]);
  const changing = socket("changing");
  await subscribe(changing);
  await subscribe(changing);
  expect(changing.closes).toEqual([1008]);
});

test("a failed dispatch mark is retried without duplicate frames; health exposes failure", async () => {
  let fail = true;
  await live.stop();
  live = new LiveDelivery({
    auth,
    reads,
    dispatch: {
      ...dispatch,
      async markDispatched(ids) {
        if (fail) throw new Error("private database connection details");
        await dispatch.markDispatched(ids);
      },
    },
  });
  await append();
  const client = socket();
  await subscribe(client);
  await live.tick();
  expect(live.status.degraded).toBe(true);
  expect(await dispatch.pending()).toHaveLength(1);
  fail = false;
  await live.tick();
  expect(live.status.degraded).toBe(false);
  expect(events(client)).toHaveLength(1);
  expect(await dispatch.pending()).toEqual([]);
});

test("delivery grants can mark only delivery columns; API cannot mark outbox or inspect other follows", async () => {
  const event = await append();
  await expect(
    transaction((tx) => createLiveDispatchStore(tx).markDispatched([BigInt(event.eventId)])),
  ).rejects.toThrow();
  await expect(delivery((tx) => tx.select().from(sessions))).rejects.toThrow();
  expect(await transaction((tx) => tx.select().from(userWalletSubscriptions))).toEqual([]);
  await dispatch.markDispatched([BigInt(event.eventId)]);
  expect(await dispatch.pending()).toEqual([]);
});

// Real loopback WebSockets exercise Hono's upgrade adapter without a browser.
test("Bun upgrades /live and sends protocol frames; token query parameters are rejected", async () => {
  const event = await append();
  const app = createApp(
    { async ping() {}, reads: createReadStore(drizzle(pg)) },
    { store: auth, uri: "https://waffle.example" },
    undefined,
    live,
  );
  let serverClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    serverClosed = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => app.fetch(request, { server, remoteAddress: "127.0.0.1" }),
    websocket: {
      ...websocket,
      close(ws, code, reason) {
        websocket.close?.(ws, code, reason);
        serverClosed?.();
      },
      maxPayloadLength: 2048,
      backpressureLimit: 65536,
      closeOnBackpressureLimit: true,
    },
  });
  let socket: WebSocket | undefined;
  try {
    const rejected = await fetch(`${server.url.origin}/live?accessToken=never-in-a-url`);
    expect(rejected.status).toBe(400);
    await rejected.text();
    const frames: LiveServerEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket test timed out")), 3000);
      socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`);
      socket.onopen = () => socket?.send(JSON.stringify({ v: 1, type: "subscribe", view: "all", cursor: null }));
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket failed"));
      };
      socket.onmessage = (message) => {
        const frame = liveServerEventSchema.parse(JSON.parse(String(message.data)));
        frames.push(frame);
        if (frame.type === "ready") {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
    expect(frames[0]).toMatchObject({ type: "signal", ...event });
    expect(frames[1]?.type).toBe("ready");
  } finally {
    // Await the server close callback before shutting down the delivery service.
    if (socket) {
      socket.close();
      await closed;
    }
    await live.stop();
    server.stop(true);
  }
});
