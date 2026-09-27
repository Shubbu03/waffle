import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createSignInMessage } from "@solana/wallet-standard-util";
import { type AuthTransaction, createAuthStore } from "@waffle/db";
import { authChallengeResponseSchema, authVerifyResponseSchema, type SignInInput } from "@waffle/shared";
import bs58 from "bs58";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { createAuthService, hashSecret, withOwner } from "../src/auth.ts";
import { createAuthLimiter } from "../src/auth-routes.ts";
import { parseApiEnv } from "../src/config.ts";

const uri = "https://waffle.example";
let pg: PGlite;
const transaction: AuthTransaction = (run) =>
  pg.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE auth_test_login");
    return run(
      async <T extends Record<string, unknown>>(text: string, parameters: string[] = []) =>
        (await tx.query<T>(text, parameters)).rows,
    );
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
function signed(
  challenge: Awaited<ReturnType<typeof service.challenge>>,
  account = wallet(),
  overrides: Partial<SignInInput> = {},
) {
  const message = createSignInMessage({ ...challenge.signInInput, ...overrides, address: account.address });
  return {
    challengeId: challenge.challengeId,
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
  const response = await post("verify", signed(await service.challenge(), account));
  expect(response.status).toBe(200);
  return authVerifyResponseSchema.parse(await response.json());
}

describe("SIWS authentication", () => {
  test("issues five-minute challenges, persists hashes, verifies real signatures and reuses wallet user", async () => {
    const response = await post("challenge", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const challenge = authChallengeResponseSchema.parse(await response.json());
    const input = challenge.signInInput;
    expect(Date.parse(input.expirationTime) - Date.parse(input.issuedAt)).toBe(300_000);
    expect(input.nonce).toMatch(/^[a-f0-9]{32}$/);
    const stored = await pg.query<{ nonce_hash: string }>("SELECT nonce_hash FROM auth_challenges WHERE id = $1", [
      challenge.challengeId,
    ]);
    expect(stored.rows[0]?.nonce_hash).toBe(hashSecret(input.nonce));
    const account = wallet();
    const result = await service.verify(signed(challenge, account));
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected login");
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

  test("replay and concurrent verification produce exactly one session", async () => {
    const request = signed(await service.challenge());
    const results = await Promise.all([service.verify(request), service.verify(request)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await service.verify(request)).toBeNull();
    const winner = results.find((result) => result !== null);
    const rows = await pg.query("SELECT * FROM sessions WHERE user_id = $1", [winner?.session.userId]);
    expect(rows.rows).toHaveLength(1);
  });

  test("invalid signatures, wrong account and every changed SIWS field fail without consuming challenge", async () => {
    const challenge = await service.challenge();
    const account = wallet();
    const request = signed(challenge, account);
    expect(await service.verify({ ...request, signatureBase64: Buffer.alloc(64).toString("base64") })).toBeNull();
    expect(await service.verify({ ...request, accountAddress: wallet().address })).toBeNull();
    expect(
      await service.verify({ ...request, signedMessageBase64: Buffer.from("not a sign-in").toString("base64") }),
    ).toBeNull();
    const mutations = [
      { domain: "evil.example" },
      { uri: "https://evil.example" },
      { chainId: "mainnet" },
      { nonce: "a".repeat(32) },
      { statement: "Different statement" },
      { issuedAt: new Date(Date.now() - 60_000).toISOString() },
      { expirationTime: new Date(Date.now() + 60_000).toISOString() },
    ] satisfies Partial<SignInInput>[];
    for (const mutation of mutations) expect(await service.verify(signed(challenge, account, mutation))).toBeNull();
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
    expect(await service.verify(request)).not.toBeNull();
  });

  test("rejects small-order account forgery and unsigned or extra message content", async () => {
    const challenge = await service.challenge();
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const address = bs58.encode(identity);
    const forged = new Uint8Array(64);
    forged[0] = 1;
    expect(
      await service.verify({
        challengeId: challenge.challengeId,
        accountAddress: address,
        signedMessageBase64: Buffer.from(createSignInMessage({ ...challenge.signInInput, address })).toString("base64"),
        signatureBase64: Buffer.from(forged).toString("base64"),
      }),
    ).toBeNull();
    const account = wallet();
    const request = signed(challenge, account);
    const original = Buffer.from(request.signedMessageBase64, "base64");
    expect(
      await service.verify({
        ...request,
        signedMessageBase64: Buffer.concat([original, Buffer.from("\n")]).toString("base64"),
      }),
    ).toBeNull();
    for (const extra of [
      { requestId: "unrequested" },
      { resources: ["https://evil.example"] },
      { notBefore: challenge.signInInput.issuedAt },
    ]) {
      const message = createSignInMessage({ ...challenge.signInInput, address: account.address, ...extra });
      expect(
        await service.verify({
          ...request,
          signedMessageBase64: Buffer.from(message).toString("base64"),
          signatureBase64: sign(null, message, account.privateKey).toString("base64"),
        }),
      ).toBeNull();
    }
  });

  test("expired challenges, changed deployment URI and unknown IDs fail", async () => {
    const challenge = await service.challenge();
    const request = signed(challenge);
    expect(await createAuthService(store, "https://new-tunnel.example").verify(request)).toBeNull();
    expect(await service.verify({ ...request, challengeId: crypto.randomUUID() })).toBeNull();
    await pg.query(
      "UPDATE auth_challenges SET issued_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE id = $1",
      [challenge.challengeId],
    );
    expect(await service.verify(request)).toBeNull();
  });

  test("final consume rechecks expiry and rolls back consumption if session creation fails", async () => {
    const challenge = await service.challenge();
    const stored = await store.findChallenge(challenge.challengeId);
    if (!stored) throw new Error("Expected challenge");
    const existing = await login();
    await expect(store.completeSignIn(stored, wallet().address, hashSecret(existing.accessToken))).rejects.toThrow();
    expect(await store.findChallenge(challenge.challengeId)).not.toBeNull();
    await pg.query(
      "UPDATE auth_challenges SET issued_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE id = $1",
      [challenge.challengeId],
    );
    expect(await store.completeSignIn(stored, wallet().address, "f".repeat(64))).toBeNull();
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
  test("rejects malformed bodies and oversized payloads with shared errors", async () => {
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
    expect(
      (await post("verify", signed(await service.challenge()), app(), { "content-type": "text/plain" })).status,
    ).toBe(415);
  });

  test("rate limits by peer and wallet and ignores spoofed forwarding headers", async () => {
    const application = app();
    for (let i = 0; i < 10; i++)
      expect((await post("challenge", {}, application, { "x-forwarded-for": `192.0.2.${i}` })).status).toBe(200);
    const limited = await post("challenge", {}, application);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const request = signed(await service.challenge());
    request.signatureBase64 = Buffer.alloc(64).toString("base64");
    for (let i = 0; i < 10; i++) {
      const response = await application.request(
        "/auth/verify",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
        { remoteAddress: `192.0.2.${i}` },
      );
      expect(response.status).toBe(401);
    }
    expect((await post("verify", request, application)).status).toBe(429);
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

test("owner operations use authenticated identity, deny anonymous/cross-user access and reset on commit and rollback", async () => {
  const a = await login();
  const b = await login();
  const application = app();
  application.post("/test-private", (c) =>
    withOwner(c, store, async (query, session) => {
      const rows = await query<{ userId: string }>(
        "INSERT INTO push_tokens (user_id, token_hash, token, notification_permission) VALUES ($1, $2, 'device', 'granted') RETURNING user_id AS \"userId\"",
        [session.userId, hashSecret(crypto.randomUUID())],
      );
      return c.json(rows);
    }),
  );
  expect((await application.request("/test-private", { method: "POST" })).status).toBe(401);
  const own = await application.request("/test-private", {
    method: "POST",
    headers: { authorization: `Bearer ${a.accessToken}` },
  });
  expect(await own.json()).toEqual([{ userId: a.session.userId }]);
  expect(await store.withSession(hashSecret(b.accessToken), (query) => query("SELECT * FROM push_tokens"))).toEqual([]);
  expect(
    await store.withSession(hashSecret(b.accessToken), (query) =>
      query("UPDATE push_tokens SET active = false WHERE user_id = $1 RETURNING id", [a.session.userId]),
    ),
  ).toEqual([]);
  await expect(
    store.withSession(hashSecret(a.accessToken), (query) =>
      query(
        "INSERT INTO push_tokens (user_id, token_hash, token, notification_permission) VALUES ($1, $2, 'device', 'granted')",
        [b.session.userId, hashSecret(crypto.randomUUID())],
      ),
    ),
  ).rejects.toThrow();
  expect(await transaction((query) => query("SELECT * FROM push_tokens"))).toEqual([]);
  await expect(
    transaction((query) =>
      query(
        "INSERT INTO push_tokens (user_id, token_hash, token, notification_permission) VALUES ($1, $2, 'device', 'granted')",
        [a.session.userId, hashSecret(crypto.randomUUID())],
      ),
    ),
  ).rejects.toThrow();
  await expect(
    store.withSession(hashSecret(a.accessToken), async (query) => {
      await query("UPDATE push_tokens SET active = false");
      throw new Error("Abort owner operation");
    }),
  ).rejects.toThrow("Abort owner operation");
  expect(await transaction((query) => query("SELECT * FROM push_tokens"))).toEqual([]);
  expect(
    await store.withSession(hashSecret(a.accessToken), (query) => query("SELECT active FROM push_tokens")),
  ).toEqual([{ active: true }]);
  const facts = await transaction((query) =>
    query("SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"),
  );
  expect(facts).toEqual([{ current_user: "auth_test_login", rolsuper: false, rolbypassrls: false }]);
});

test("every private table enforces owner read/insert/update/delete through the API role", async () => {
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
  const tables = [
    {
      name: "user_wallet_subscriptions",
      insert: "INSERT INTO user_wallet_subscriptions (user_id, watched_wallet_id) VALUES ($1, $2)",
      args: () => [walletId],
      update: "alerts_enabled = false",
    },
    {
      name: "push_tokens",
      insert:
        "INSERT INTO push_tokens (user_id, token_hash, token, notification_permission) VALUES ($1, $2, 'test', 'granted')",
      args: () => [hashSecret(crypto.randomUUID())],
      update: "active = false",
    },
    {
      name: "paper_positions",
      insert:
        "INSERT INTO paper_positions (user_id, signal_id, size_lamports, entry_quote) VALUES ($1, $2, 1000, '{}')",
      args: () => [signalId],
      update: "size_lamports = 2000",
    },
    {
      name: "trade_attempts",
      insert:
        "INSERT INTO trade_attempts (user_id, signal_id, quote_id, request_id, taker, router, input_amount_lamports) VALUES ($1, $2, $3, $4, $5, 'metis', 1000)",
      args: () => [signalId, crypto.randomUUID(), crypto.randomUUID(), address],
      update: "input_amount_lamports = 2000",
    },
  ];
  for (const table of tables) {
    await expect(transaction((query) => query(table.insert, [a.session.userId, ...table.args()]))).rejects.toThrow();
    await expect(
      store.withSession(hashSecret(b.accessToken), (query) => query(table.insert, [a.session.userId, ...table.args()])),
    ).rejects.toThrow();
    const owned = await store.withSession(hashSecret(a.accessToken), (query) =>
      query(`${table.insert} RETURNING user_id`, [a.session.userId, ...table.args()]),
    );
    expect(owned).toEqual([{ user_id: a.session.userId }]);
    // Table names and assignment clauses below are static test fixtures, never request input.
    expect(await transaction((query) => query(`SELECT user_id FROM ${table.name}`))).toEqual([]);
    expect(
      await store.withSession(hashSecret(b.accessToken), (query) => query(`SELECT user_id FROM ${table.name}`)),
    ).toEqual([]);
    expect(
      await store.withSession(hashSecret(b.accessToken), (query) =>
        query(`UPDATE ${table.name} SET ${table.update} RETURNING user_id`),
      ),
    ).toEqual([]);
    expect(
      await store.withSession(hashSecret(b.accessToken), (query) =>
        query(`DELETE FROM ${table.name} RETURNING user_id`),
      ),
    ).toEqual([]);
    await expect(
      store.withSession(hashSecret(a.accessToken), (query) =>
        query(`UPDATE ${table.name} SET user_id = $1 WHERE user_id = $2`, [b.session.userId, a.session.userId]),
      ),
    ).rejects.toThrow();
    expect(
      await store.withSession(hashSecret(a.accessToken), (query) =>
        query(`SELECT user_id FROM ${table.name} WHERE user_id = $1`, [a.session.userId]),
      ),
    ).toEqual([{ user_id: a.session.userId }]);
    expect(
      await store.withSession(hashSecret(a.accessToken), (query) =>
        query(`UPDATE ${table.name} SET ${table.update} WHERE user_id = $1 RETURNING user_id`, [a.session.userId]),
      ),
    ).toEqual([{ user_id: a.session.userId }]);
    expect(
      await store.withSession(hashSecret(a.accessToken), (query) =>
        query(`DELETE FROM ${table.name} WHERE user_id = $1 RETURNING user_id`, [a.session.userId]),
      ),
    ).toEqual([{ user_id: a.session.userId }]);
  }
});
