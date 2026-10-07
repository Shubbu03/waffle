import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  createAuthStore,
  createLiveReadStore,
  createReadStore,
  createWalletTrackingStore,
  type DatabaseTransaction,
  MAX_ACTIVE_WALLETS,
} from "@waffle/db";
import { sessions, users, watchedWallets } from "@waffle/db/schema";
import type { HttpTransport } from "@waffle/http";
import {
  apiErrorSchema,
  PUMP_SWAP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  signalPageSchema,
  trackedWalletsResponseSchema,
  trackWalletResponseSchema,
  untrackWalletResponseSchema,
  WRAPPED_SOL_MINT,
  walletCatalogResponseSchema,
} from "@waffle/shared";
import bs58 from "bs58";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";
import { createWalletActivityValidator } from "../src/wallet-activity.ts";
import { isOnCurveAddress } from "../src/wallet-address.ts";

let pg: PGlite;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const catalogA = "33333333-3333-4333-8333-333333333333";
const catalogB = "44444444-4444-4444-8444-444444444444";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);

/** Fresh on-curve wallet address (real ed25519 key). */
function walletAddress(): string {
  const keys = generateKeyPairSync("ed25519");
  return bs58.encode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}
const catalogAddressA = walletAddress();
const catalogAddressB = walletAddress();

const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE tracking_test_login`);
    return run(tx);
  });
const auth = createAuthStore(transaction);
const reads: ReturnType<typeof createReadStore> = {
  wallets: () => transaction((tx) => createReadStore(tx).wallets()),
  signals: (input, ownerId) => transaction((tx) => createReadStore(tx).signals(input, ownerId)),
  signal: (id) => transaction((tx) => createReadStore(tx).signal(id)),
};
const livePage = (cursor: string | null, ownerId?: string) =>
  transaction((tx) => createLiveReadStore(tx).page(cursor, ownerId));
const app = createApp({ reads, async ping() {} }, { store: auth, uri: "https://waffle.example" });

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec("CREATE ROLE tracking_test_login LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO tracking_test_login");
  await pg.query(
    "INSERT INTO watched_wallets (id, address, label, inclusion_reason, source) VALUES ($1, $2, 'Catalog A', 'Reviewed', 'catalog'), ($3, $4, 'Catalog B', 'Reviewed', 'catalog')",
    [catalogA, catalogAddressA, catalogB, catalogAddressB],
  );
});

beforeEach(async () => {
  await pg.exec("TRUNCATE users, signals CASCADE");
  // Drop user-sourced wallets from the previous test and reset catalog state.
  await pg.exec("DELETE FROM watched_wallets WHERE source = 'user'");
  await pg.exec("UPDATE watched_wallets SET active = true, source = 'catalog'");
  await pg.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2), ($3, $4)", [
    ownerA,
    walletAddress(),
    ownerB,
    walletAddress(),
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
  return app.request(`/wallets${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function addWallet(address: string, label?: string, token = tokenA) {
  return request("POST", "", label ? { address, label } : { address }, token);
}
async function untrack(walletId: string, token = tokenA) {
  return request("DELETE", `/${walletId}`, undefined, token);
}
async function mine(token = tokenA) {
  const response = await request("GET", "/mine", undefined, token);
  expect(response.status).toBe(200);
  return trackedWalletsResponseSchema.parse(await response.json()).items;
}
async function assertError(response: Response, status: number) {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.requestId).toBe(response.headers.get("x-request-id") ?? undefined);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return body;
}

describe("tracking a pasted wallet", () => {
  test("creates a user wallet, auto-follows with alerts off, and reports creation", async () => {
    const address = walletAddress();
    const response = await addWallet(address, "My whale");
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = trackWalletResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ created: true, followed: true });
    expect(body.wallet).toMatchObject({ address, label: "My whale", active: true, source: "user" });
    const rows = await pg.query<{ alerts_enabled: boolean; source: string; tracked: number }>(
      `SELECT s.alerts_enabled, w.source,
        (SELECT count(*)::int FROM user_tracked_wallets t WHERE t.watched_wallet_id = w.id) AS tracked
       FROM user_wallet_subscriptions s JOIN watched_wallets w ON w.id = s.watched_wallet_id
       WHERE s.user_id = $1`,
      [ownerA],
    );
    expect(rows.rows).toEqual([{ alerts_enabled: false, source: "user", tracked: 1 }]);
    expect(await mine()).toEqual([body.wallet.id]);
  });

  test("derives a label when none is supplied", async () => {
    const address = walletAddress();
    const body = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    expect(body.wallet.label).toBe(`Tracked · ${address.slice(0, 4)}…${address.slice(-4)}`);
  });

  test("re-adding the same address is idempotent and never duplicates rows", async () => {
    const address = walletAddress();
    const first = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    const second = await addWallet(address);
    expect(second.status).toBe(200);
    const again = trackWalletResponseSchema.parse(await second.json());
    expect(again.created).toBe(false);
    expect(again.wallet.id).toBe(first.wallet.id);
    const counts = await pg.query<{ wallets: number; tracking: number; subs: number }>(
      `SELECT (SELECT count(*)::int FROM watched_wallets WHERE address = $1) AS wallets,
        (SELECT count(*)::int FROM user_tracked_wallets) AS tracking,
        (SELECT count(*)::int FROM user_wallet_subscriptions) AS subs`,
      [address],
    );
    expect(counts.rows).toEqual([{ wallets: 1, tracking: 1, subs: 1 }]);
  });

  test("enforces the three-wallet per-user cap", async () => {
    for (let i = 0; i < 3; i++) expect((await addWallet(walletAddress())).status).toBe(201);
    expect((await assertError(await addWallet(walletAddress()), 409)).error.code).toBe("CONFLICT");
    expect((await mine()).length).toBe(3);
  });

  test("enforces the global active-wallet cap", async () => {
    const active = await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM watched_wallets WHERE active");
    const need = MAX_ACTIVE_WALLETS - (active.rows[0]?.count ?? 0);
    for (let i = 0; i < need; i++) {
      await pg.query(
        "INSERT INTO watched_wallets (address, label, inclusion_reason, source, active) VALUES ($1, 'Filler', 'Filler', 'user', true)",
        [walletAddress()],
      );
    }
    expect((await assertError(await addWallet(walletAddress()), 409)).error.code).toBe("CONFLICT");
  });

  test("adding a catalog address follows it without creating a tracking row", async () => {
    const response = await addWallet(catalogAddressA);
    expect(response.status).toBe(200);
    const body = trackWalletResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ created: false, followed: true });
    expect(body.wallet.source).toBe("catalog");
    const tracked = await pg.query("SELECT 1 FROM user_tracked_wallets");
    expect(tracked.rows).toHaveLength(0);
    const subs = await pg.query("SELECT 1 FROM user_wallet_subscriptions");
    expect(subs.rows).toHaveLength(1);
  });

  test("rejects a paused catalog wallet", async () => {
    await pg.query("UPDATE watched_wallets SET active = false WHERE id = $1", [catalogA]);
    expect((await assertError(await addWallet(catalogAddressA), 409)).error.code).toBe("CONFLICT");
  });

  test("re-adding a paused user wallet reactivates it", async () => {
    const address = walletAddress();
    const body = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    expect(untrackWalletResponseSchema.parse(await (await untrack(body.wallet.id)).json()).paused).toBe(true);
    const active = await pg.query<{ active: boolean }>("SELECT active FROM watched_wallets WHERE id = $1", [
      body.wallet.id,
    ]);
    expect(active.rows).toEqual([{ active: false }]);
    const readded = await addWallet(address);
    expect(readded.status).toBe(200);
    const reactivated = await pg.query<{ active: boolean }>("SELECT active FROM watched_wallets WHERE id = $1", [
      body.wallet.id,
    ]);
    expect(reactivated.rows).toEqual([{ active: true }]);
  });
});

describe("untracking", () => {
  test("pauses a user wallet only when the last tracker leaves", async () => {
    const address = walletAddress();
    const a = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    const b = trackWalletResponseSchema.parse(await (await addWallet(address, undefined, tokenB)).json());
    expect(a.wallet.id).toBe(b.wallet.id);
    expect(untrackWalletResponseSchema.parse(await (await untrack(a.wallet.id)).json()).paused).toBe(false);
    const stillActive = await pg.query<{ active: boolean }>("SELECT active FROM watched_wallets WHERE id = $1", [
      a.wallet.id,
    ]);
    expect(stillActive.rows).toEqual([{ active: true }]);
    expect(untrackWalletResponseSchema.parse(await (await untrack(a.wallet.id, tokenB)).json()).paused).toBe(true);
    const paused = await pg.query<{ active: boolean }>("SELECT active FROM watched_wallets WHERE id = $1", [
      a.wallet.id,
    ]);
    expect(paused.rows).toEqual([{ active: false }]);
  });

  test("removes the caller's follow and rejects wallets they do not track", async () => {
    const address = walletAddress();
    const body = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    expect(await mine()).toEqual([body.wallet.id]);
    await untrack(body.wallet.id);
    expect(await mine()).toEqual([]);
    const subs = await pg.query("SELECT 1 FROM user_wallet_subscriptions");
    expect(subs.rows).toHaveLength(0);
    expect((await assertError(await untrack(body.wallet.id), 404)).error.code).toBe("NOT_FOUND");
    expect((await assertError(await untrack(catalogA), 404)).error.code).toBe("NOT_FOUND");
  });
});

describe("tracking access boundaries", () => {
  test("anonymous and invalid sessions cannot track, untrack or list", async () => {
    for (const token of [null, "invalid", "c".repeat(43)]) {
      await assertError(await request("POST", "", { address: walletAddress() }, token), 401);
      await assertError(await request("DELETE", `/${catalogA}`, undefined, token), 401);
      await assertError(await request("GET", "/mine", undefined, token), 401);
    }
  });

  test("a user cannot untrack another user's wallet and RLS blocks cross-owner writes", async () => {
    const address = walletAddress();
    const body = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    expect(await mine(tokenB)).toEqual([]);
    expect((await assertError(await untrack(body.wallet.id, tokenB), 404)).error.code).toBe("NOT_FOUND");
    expect(await mine()).toEqual([body.wallet.id]);
    await expect(
      auth.withSession(hashSecret(tokenA), (tx) => createWalletTrackingStore(tx, ownerB).add(walletAddress())),
    ).rejects.toThrow();
  });

  test("rejects malformed bodies, unknown fields and oversized payloads", async () => {
    await assertError(await request("POST", "", {}), 400);
    await assertError(await request("POST", "", { address: walletAddress(), userId: ownerB }), 400);
    await assertError(await request("POST", "", { address: walletAddress(), label: "x".repeat(81) }), 400);
    await assertError(await request("DELETE", "/bad-id"), 400);
    await assertError(await request("GET", "/mine?userId=other"), 400);
    await assertError(
      await app.request("/wallets", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: "{",
      }),
      400,
    );
    await assertError(
      await app.request("/wallets", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "text/plain" },
        body: "{}",
      }),
      415,
    );
    await assertError(await request("POST", "", { address: walletAddress(), pad: "x".repeat(5000) }), 413);
  });
});

describe("on-curve wallet validation", () => {
  test("accepts a real wallet and rejects off-curve and malformed addresses", () => {
    expect(isOnCurveAddress(walletAddress())).toBe(true);
    expect(isOnCurveAddress("0OIl")).toBe(false);
    expect(isOnCurveAddress("")).toBe(false);
    let offCurve: string | null = null;
    for (let i = 0; i < 64 && offCurve === null; i++) {
      const bytes = new Uint8Array(32).fill(i);
      const candidate = bs58.encode(bytes);
      if (!isOnCurveAddress(candidate)) offCurve = candidate;
    }
    expect(offCurve).not.toBeNull();
    expect(isOnCurveAddress(offCurve as string)).toBe(false);
  });

  test("rejects an off-curve address at the route", async () => {
    let offCurve = "";
    for (let i = 0; i < 64; i++) {
      const candidate = bs58.encode(new Uint8Array(32).fill(i));
      if (!isOnCurveAddress(candidate)) {
        offCurve = candidate;
        break;
      }
    }
    expect((await assertError(await addWallet(offCurve), 400)).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("curated All feed", () => {
  async function insertSignal(walletId: string, signatureChar: string): Promise<string> {
    const now = Date.now();
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
    const id = crypto.randomUUID();
    const signature = bs58.encode(new Uint8Array(64).fill(signatureChar === "1" ? 1 : 2));
    await pg.query(
      `INSERT INTO signals (id, signature, wallet_id, mint_address, source_program_id, slot, observed_at,
      score_version, score, status, data_status, reasons, snapshot)
      VALUES ($1, $2, $3, $4, $5, 100, $6, 1, $7, $8, 'unknown', $9, $10)`,
      [
        id,
        signature,
        walletId,
        SPL_TOKEN_PROGRAM_ID,
        PUMP_SWAP_PROGRAM_ID,
        new Date(now).toISOString(),
        scored.score,
        scored.status,
        JSON.stringify(scored.reasons),
        JSON.stringify(snapshot),
      ],
    );
    await pg.query("INSERT INTO signal_events (signal_id) VALUES ($1)", [id]);
    return id;
  }

  test("All hides user wallets; Following shows them to followers", async () => {
    const address = walletAddress();
    const tracked = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    await addWallet(catalogAddressA);
    const catalogSignal = await insertSignal(catalogA, "1");
    const userSignal = await insertSignal(tracked.wallet.id, "2");
    const all = signalPageSchema.parse(await (await app.request("/signals?view=all")).json());
    expect(all.items.map((item) => item.id)).toEqual([catalogSignal]);
    const following = signalPageSchema.parse(
      await (await app.request("/signals?view=following", { headers: { authorization: `Bearer ${tokenA}` } })).json(),
    );
    expect(new Set(following.items.map((item) => item.id))).toEqual(new Set([catalogSignal, userSignal]));
  });

  test("the live All page excludes user wallets while an owner page includes their follow", async () => {
    const address = walletAddress();
    const tracked = trackWalletResponseSchema.parse(await (await addWallet(address)).json());
    await addWallet(catalogAddressA);
    const catalogSignal = await insertSignal(catalogA, "3");
    const userSignal = await insertSignal(tracked.wallet.id, "4");
    const all = await livePage(null);
    expect(all.events.map((event) => event.signalId)).toEqual([catalogSignal]);
    const following = await auth.withSession(hashSecret(tokenA), (tx) => createLiveReadStore(tx).page(null, ownerA));
    if (!following) throw new Error("Expected an owner live page");
    expect(new Set(following.events.map((event) => event.signalId))).toEqual(new Set([catalogSignal, userSignal]));
  });

  test("the catalog response exposes source for badges", async () => {
    await addWallet(walletAddress());
    const catalog = walletCatalogResponseSchema.parse(await (await app.request("/wallets")).json());
    expect(catalog.items.filter((item) => item.source === "user")).toHaveLength(1);
    expect(catalog.items.filter((item) => item.source === "catalog")).toHaveLength(2);
  });
});

describe("track-time activity validation", () => {
  const NOW = Date.now();
  function history(count: number, ageMinutes = 1) {
    return Array.from({ length: count }, (_, i) => ({
      signature: `sig${i}`,
      err: null,
      blockTime: Math.floor(NOW / 1_000) - ageMinutes * 60 - i,
    }));
  }
  function validatingApp(entries: unknown, pumpSwap = true) {
    const transport = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method === "getSignaturesForAddress") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: entries });
      }
      const result = pumpSwap
        ? {
            transaction: { message: { accountKeys: [{ pubkey: PUMP_SWAP_PROGRAM_ID }], instructions: [] } },
            meta: { innerInstructions: [] },
          }
        : { transaction: { message: { accountKeys: [], instructions: [] } }, meta: { innerInstructions: [] } };
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }) as HttpTransport;
    const activity = createWalletActivityValidator({
      url: "https://rpc.example",
      transport,
      now: () => NOW,
      sleep: async () => {},
    });
    return createApp({ reads, async ping() {} }, { store: auth, uri: "https://waffle.example", activity });
  }
  function post(application: ReturnType<typeof createApp>, address: string, remoteAddress?: string) {
    return application.request(
      "/wallets",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: JSON.stringify({ address }),
      },
      remoteAddress ? { remoteAddress } : undefined,
    );
  }

  test("rejects a wallet with no history", async () => {
    const response = await post(validatingApp([]), walletAddress());
    expect((await assertError(response, 422)).error.code).toBe("NO_HISTORY");
  });

  test("rejects a wallet without recent PumpSwap activity", async () => {
    const response = await post(validatingApp(history(5), false), walletAddress());
    expect((await assertError(response, 422)).error.code).toBe("UNSUPPORTED_WALLET");
  });

  test("accepts a PumpSwap trader without a warning", async () => {
    const response = await post(validatingApp(history(3)), walletAddress());
    expect(response.status).toBe(201);
    expect(trackWalletResponseSchema.parse(await response.json()).warning).toBeUndefined();
  });

  test("warns between 31 and 100 transactions per hour", async () => {
    const response = await post(validatingApp(history(40)), walletAddress());
    expect(response.status).toBe(201);
    expect(trackWalletResponseSchema.parse(await response.json()).warning).toBe("very-active");
  });

  test("rejects a wallet above 100 transactions per hour", async () => {
    const response = await post(validatingApp(history(120)), walletAddress());
    expect((await assertError(response, 422)).error.code).toBe("TOO_ACTIVE");
  });

  test("rate limits track attempts before spending RPC", async () => {
    const application = validatingApp(history(3));
    let status = 0;
    for (let attempt = 0; attempt < 11; attempt++) {
      status = (await post(application, walletAddress(), "192.0.2.77")).status;
    }
    expect(status).toBe(429);
  });

  test("skips validation when no validator is configured", async () => {
    expect((await post(app, walletAddress())).status).toBe(201);
  });
});
