import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createSignInMessage } from "@solana/wallet-standard-util";
import { createAuthStore, type DatabaseExecutor, type DatabaseTransaction } from "@waffle/db";
import { paperPositions, pushTokens, tradeAttempts, userWalletSubscriptions } from "@waffle/db/schema";
import { authVerifyResponseSchema, type SignInInput } from "@waffle/shared";
import bs58 from "bs58";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { createAuthService, hashSecret, withOwner } from "../src/auth.ts";
import { createAuthLimiter } from "../src/auth-routes.ts";
import { parseApiEnv } from "../src/config.ts";

const uri = "https://waffle.example";
let pg: PGlite;
const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE auth_test_login`);
    return run(tx);
  });
const store = createAuthStore(transaction);
const service = createAuthService(store, uri);

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec("CREATE ROLE auth_test_login LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO auth_test_login");
});
afterAll(async () => {
  await pg?.close();
});

function wallet() {
  const keys = generateKeyPairSync("ed25519");
  const address = bs58.encode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  return { ...keys, address };
}
/** Client-built input: trailing-slash uri matches the server's normalized identity. */
function freshInput(overrides: Partial<SignInInput> = {}): SignInInput {
  const now = Date.now();
  return {
    domain: "waffle.example",
    uri: "https://waffle.example/",
    version: "1",
    chainId: "solana:mainnet",
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + 5 * 60_000).toISOString(),
    statement: "Sign in to waffle. This does not authorize any transactions.",
    ...overrides,
  };
}
function signed(account = wallet(), overrides: Record<string, string> = {}) {
  const message = createSignInMessage({ ...freshInput(), ...overrides, address: account.address });
  return {
    accountAddress: account.address,
    signedMessageBase64: Buffer.from(message).toString("base64"),
    signatureBase64: sign(null, message, account.privateKey).toString("base64"),
  };
}
function app() {
  return createApp({ async ping() {} }, { store, uri });
}
function post(path: string, data: unknown, application = app(), headers: Record<string, string> = {}) {
  return application.request(`/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
}
async function login(account = wallet()) {
  const response = await post("verify", signed(account));
  expect(response.status).toBe(200);
  return authVerifyResponseSchema.parse(await response.json());
}

describe("SIWS authentication", () => {
  test("verifies fresh signatures, reuses the wallet user and mints 7-day sessions", async () => {
    const account = wallet();
    const result = await login(account);
    const session = await pg.query<{ token_hash: string; lifetime: number }>(
      "SELECT token_hash, extract(epoch FROM expires_at - created_at)::int AS lifetime FROM sessions WHERE token_hash = $1",
      [hashSecret(result.accessToken)],
    );
    expect(session.rows).toEqual([{ token_hash: hashSecret(result.accessToken), lifetime: 604800 }]);
    expect((await login(account)).session.userId).toBe(result.session.userId);
    const current = await app().request("/auth/session", {
      headers: { authorization: `Bearer ${result.accessToken}` },
    });
    expect(await current.json()).toEqual({ session: result.session });
  });

  test("replays within the skew window mint equivalent sessions for the same wallet", async () => {
    // Stateless by design: no challenge to consume, so the same proof verifies
    // twice. A replay only re-authenticates the same key owner — useless to steal.
    const request = signed();
    const first = await service.verify(request);
    const second = await service.verify(request);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.session.userId).toBe(second?.session.userId);
  });

  test("invalid signatures, wrong account and every changed SIWS field fail", async () => {
    const account = wallet();
    const request = signed(account);
    expect(await service.verify({ ...request, signatureBase64: Buffer.alloc(64).toString("base64") })).toBeNull();
    expect(await service.verify({ ...request, accountAddress: wallet().address })).toBeNull();
    expect(
      await service.verify({ ...request, signedMessageBase64: Buffer.from("not a sign-in").toString("base64") }),
    ).toBeNull();
    const mutations = [
      { domain: "evil.example" },
      { uri: "https://evil.example" },
      { chainId: "devnet" },
      { issuedAt: new Date(Date.now() - 300_000).toISOString() },
      { issuedAt: new Date(Date.now() + 300_000).toISOString() },
      { expirationTime: new Date(Date.now() - 1000).toISOString() },
    ] satisfies Array<Record<string, string>>;
    for (const mutation of mutations) expect(await service.verify(signed(account, mutation))).toBeNull();
    // Statement text is display-only: an owner-signed statement always verifies.
    // Security comes from domain/uri/freshness/signature, not the prose.
    expect(await service.verify(signed(account, { statement: "Different statement" }))).not.toBeNull();
    const wrongVersion = Buffer.from(request.signedMessageBase64, "base64")
      .toString()
      .replace("Version: 1", "Version: 2");
    expect(
      await service.verify({
        ...request,
        signedMessageBase64: Buffer.from(wrongVersion).toString("base64"),
        signatureBase64: sign(null, Buffer.from(wrongVersion), account.privateKey).toString("base64"),
      }),
    ).toBeNull();
  });

  test("rejects small-order account forgery and tampered message bytes", async () => {
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const address = bs58.encode(identity);
    const forged = new Uint8Array(64);
    forged[0] = 1;
    const input = { ...freshInput(), address };
    expect(
      await service.verify({
        accountAddress: address,
        signedMessageBase64: Buffer.from(createSignInMessage(input)).toString("base64"),
        signatureBase64: Buffer.from(forged).toString("base64"),
      }),
    ).toBeNull();
    const account = wallet();
    const request = signed(account);
    const original = Buffer.from(request.signedMessageBase64, "base64");
    expect(
      await service.verify({
        ...request,
        signedMessageBase64: Buffer.concat([original, Buffer.from("\n")]).toString("base64"),
      }),
    ).toBeNull();
  });

  test("deployment URI mismatch fails; no challenge table exists anymore", async () => {
    const request = signed();
    expect(await createAuthService(store, "https://new-tunnel.example").verify(request)).toBeNull();
    await expect(pg.query("SELECT * FROM auth_challenges")).rejects.toThrow();
  });

  test("logout revokes only the current session; expired, missing and malformed sessions are rejected", async () => {
    const account = wallet();
    const first = await login(account);
    const second = await login(account);
    const application = app();
    const headers = { authorization: `Bearer ${first.accessToken}` };
    expect((await application.request("/auth/logout", { method: "POST", headers })).status).toBe(204);
    expect((await application.request("/auth/session", { headers })).status).toBe(401);
    expect((await application.request("/auth/logout", { method: "POST", headers })).status).toBe(401);
    expect(
      (await application.request("/auth/session", { headers: { authorization: `Bearer ${second.accessToken}` } }))
        .status,
    ).toBe(200);
    await pg.query(
      "UPDATE sessions SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE token_hash = $1",
      [hashSecret(second.accessToken)],
    );
    for (const authorization of [
      "",
      "Bearer nonsense",
      `Basic ${first.accessToken}`,
      `Bearer ${second.accessToken}`,
      `Bearer ${"a".repeat(43)}`,
    ]) {
      const response = await application.request("/auth/session", { headers: { authorization } });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
  });
});

describe("HTTP auth boundaries", () => {
  test("challenge endpoint is gone; malformed bodies and oversized payloads share errors", async () => {
    expect((await post("challenge", {})).status).toBe(404);
    expect((await post("verify", {})).status).toBe(400);
    expect(
      (
        await app().request("/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect((await post("verify", { message: "x".repeat(9000) })).status).toBe(413);
    expect((await post("verify", signed(), app(), { "content-type": "text/plain" })).status).toBe(415);
  });

  test("rate limits by peer and ignores spoofed forwarding headers", async () => {
    const application = app();
    // One bad wallet hammering the same peer: 10 answered 401s, then 429.
    // (Fresh wallets would never fill the per-wallet bucket — reuse one here.)
    const bad = signed();
    bad.signatureBase64 = Buffer.alloc(64).toString("base64");
    const attempt = (remoteAddress: string, headers: Record<string, string> = {}, request = bad) =>
      application.request(
        "/auth/verify",
        { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(request) },
        { remoteAddress },
      );
    for (let i = 0; i < 10; i++) {
      expect((await attempt("192.0.2.99")).status).toBe(401);
    }
    const limited = await attempt("192.0.2.99");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    // A spoofed forwarding header does not buy a fresh bucket on the same peer.
    const spoofed = await attempt("192.0.2.99", { "x-forwarded-for": "9.9.9.9" });
    expect(spoofed.status).toBe(429);
    // A different peer with a fresh wallet is unaffected.
    const fresh = signed();
    fresh.signatureBase64 = Buffer.alloc(64).toString("base64");
    expect((await attempt("192.0.2.100", {}, fresh)).status).toBe(401);
    let time = 0;
    const allow = createAuthLimiter(() => time);
    expect(allow("peer", 1)).toBe(true);
    expect(allow("peer", 1)).toBe(false);
    time = 60_000;
    expect(allow("peer", 1)).toBe(true);
  });

  test("requires safe configured HTTPS identity", () => {
    const DATABASE_URL = "postgresql://user:password@localhost/db?sslmode=require";
    for (const AUTH_URI of [
      undefined,
      "not-a-url",
      "http://waffle.example",
      "https://user:secret@waffle.example",
      "https://waffle.example/#bad",
    ]) {
      expect(() => parseApiEnv({ DATABASE_URL, AUTH_URI })).toThrow("AUTH_URI");
    }
  });
});

test("Drizzle binds SQL-shaped values as data and sign-in still mints its session", async () => {
  const payload = "'; DROP TABLE public.users; --";
  const queries: { text: string; parameters: unknown[] }[] = [];
  const checkedStore = createAuthStore((run) =>
    drizzle(pg, {
      logger: { logQuery: (text, parameters) => queries.push({ text, parameters }) },
    }).transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE auth_test_login`);
      return run(tx);
    }),
  );
  // Wallet addresses are opaque strings at the store boundary; SQL metacharacters must bind as data.
  const session = await checkedStore.completeSignIn(payload, hashSecret(crypto.randomUUID()));
  expect(session?.walletAddress).toBe(payload);
  expect(queries.some((query) => query.parameters.includes(payload))).toBe(true);
  expect(queries.every((query) => !query.text.includes(payload))).toBe(true);
  // A real sign-in still creates its user and session after the injection attempts.
  expect((await login()).session.userId).toBeString();
});

test("owner operations use authenticated identity, deny anonymous/cross-user access and reset on commit and rollback", async () => {
  const a = await login();
  const b = await login();
  const walletId = crypto.randomUUID();
  const signalId = crypto.randomUUID();
  const address = wallet().address;
  await pg.query("INSERT INTO watched_wallets (id, address, label, inclusion_reason) VALUES ($1, $2, 'Test', 'Test')", [
    walletId,
    address,
  ]);
  await pg.query(
    `INSERT INTO signals (id, signature, wallet_id, mint_address, source_program_id, slot,
    observed_at, score_version, score, status, data_status, reasons, snapshot)
    VALUES ($1, $2, $3, $4, $4, 1, now(), 1, 0, 'suppressed', 'unknown', '[]', '{}')`,
    [signalId, "1".repeat(64), walletId, address],
  );
  const fixtures = [
    {
      table: userWalletSubscriptions,
      insert: (tx: DatabaseExecutor, userId: string) =>
        tx
          .insert(userWalletSubscriptions)
          .values({ userId, watchedWalletId: walletId })
          .returning({ userId: userWalletSubscriptions.userId }),
      update: (tx: DatabaseExecutor, userId?: string) =>
        tx
          .update(userWalletSubscriptions)
          .set({ alertsEnabled: false })
          .where(userId ? eq(userWalletSubscriptions.userId, userId) : undefined)
          .returning({ userId: userWalletSubscriptions.userId }),
    },
    {
      table: pushTokens,
      insert: (tx: DatabaseExecutor, userId: string) =>
        tx
          .insert(pushTokens)
          .values({
            userId,
            tokenHash: hashSecret(crypto.randomUUID()),
            token: "test",
            notificationPermission: "granted",
          })
          .returning({ userId: pushTokens.userId }),
      update: (tx: DatabaseExecutor, userId?: string) =>
        tx
          .update(pushTokens)
          .set({ active: false })
          .where(userId ? eq(pushTokens.userId, userId) : undefined)
          .returning({ userId: pushTokens.userId }),
    },
    {
      table: paperPositions,
      insert: (tx: DatabaseExecutor, userId: string) =>
        tx
          .insert(paperPositions)
          .values({
            userId,
            signalId,
            sizeLamports: 1000n,
            entryQuote: sql`'{}'::jsonb`,
          })
          .returning({ userId: paperPositions.userId }),
      update: (tx: DatabaseExecutor, userId?: string) =>
        tx
          .update(paperPositions)
          .set({ sizeLamports: 2000n })
          .where(userId ? eq(paperPositions.userId, userId) : undefined)
          .returning({ userId: paperPositions.userId }),
    },
    {
      table: tradeAttempts,
      insert: (tx: DatabaseExecutor, userId: string) =>
        tx
          .insert(tradeAttempts)
          .values({
            userId,
            signalId,
            quoteId: crypto.randomUUID(),
            requestId: crypto.randomUUID(),
            taker: address,
            router: "metis",
            inputAmountLamports: 1000n,
          })
          .returning({ userId: tradeAttempts.userId }),
      update: (tx: DatabaseExecutor, userId?: string) =>
        tx
          .update(tradeAttempts)
          .set({ inputAmountLamports: 2000n })
          .where(userId ? eq(tradeAttempts.userId, userId) : undefined)
          .returning({ userId: tradeAttempts.userId }),
    },
  ];
  const application = app();
  const insertToken = (tx: DatabaseExecutor, userId: string) =>
    tx
      .insert(pushTokens)
      .values({
        userId,
        tokenHash: hashSecret(crypto.randomUUID()),
        token: "device",
        notificationPermission: "granted",
      })
      .returning({ userId: pushTokens.userId });
  application.post("/test-private", (c) =>
    withOwner(c, store, async (tx, session) => c.json(await insertToken(tx, session.userId))),
  );
  expect((await application.request("/test-private", { method: "POST" })).status).toBe(401);
  const own = await application.request("/test-private", {
    method: "POST",
    headers: { authorization: `Bearer ${a.accessToken}` },
  });
  expect(await own.json()).toEqual([{ userId: a.session.userId }]);
  expect(await store.withSession(hashSecret(b.accessToken), (tx) => tx.select().from(pushTokens))).toEqual([]);
  await expect(
    store.withSession(hashSecret(b.accessToken), (tx) => insertToken(tx, a.session.userId)),
  ).rejects.toThrow();
  // Smoke rows above would pollute the per-table assertions below; clear them (test-only superuser bypass).
  await pg.query("DELETE FROM push_tokens");
  for (const fixture of fixtures) {
    const { table, insert, update } = fixture;
    expect(await store.withSession(hashSecret(a.accessToken), (tx) => insert(tx, a.session.userId))).toEqual([
      { userId: a.session.userId },
    ]);
    expect(await transaction((tx) => tx.select({ userId: table.userId }).from(table))).toEqual([]);
    expect(
      await store.withSession(hashSecret(b.accessToken), (tx) => tx.select({ userId: table.userId }).from(table)),
    ).toEqual([]);
    expect(await store.withSession(hashSecret(b.accessToken), (tx) => update(tx))).toEqual([]);
    expect(
      await store.withSession(hashSecret(b.accessToken), (tx) => tx.delete(table).returning({ userId: table.userId })),
    ).toEqual([]);
    await expect(
      store.withSession(hashSecret(a.accessToken), (tx) =>
        tx.update(table).set({ userId: b.session.userId }).where(eq(table.userId, a.session.userId)),
      ),
    ).rejects.toThrow();
    expect(
      await store.withSession(hashSecret(a.accessToken), (tx) =>
        tx.select({ userId: table.userId }).from(table).where(eq(table.userId, a.session.userId)),
      ),
    ).toEqual([{ userId: a.session.userId }]);
    expect(await store.withSession(hashSecret(a.accessToken), (tx) => update(tx, a.session.userId))).toEqual([
      { userId: a.session.userId },
    ]);
    expect(
      await store.withSession(hashSecret(a.accessToken), (tx) =>
        tx.delete(table).where(eq(table.userId, a.session.userId)).returning({ userId: table.userId }),
      ),
    ).toEqual([{ userId: a.session.userId }]);
  }
});
