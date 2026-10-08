import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@solana/web3.js";
import {
  createAuthStore,
  createLiveReadStore,
  createPaperPositionStore,
  createReadStore,
  createSubscriptionStore,
  createTradeAttemptStore,
  createWalletTrackingStore,
  type DatabaseTransaction,
} from "@waffle/db";
import {
  PUMP_SWAP_PROGRAM_ID,
  type SolanaNetwork,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.ts";
import { hashSecret } from "../src/auth.ts";

let pg: PGlite;
const trackedAddress = Keypair.generate().publicKey.toBase58();
const owner = crypto.randomUUID();
const token = "n".repeat(43);
const transaction: DatabaseTransaction = (run) =>
  drizzle(pg).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE network_test_login`);
    return run(tx);
  });
const auth = createAuthStore(transaction);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const scoped = (network: SolanaNetwork) =>
  createApp(
    { ping: async () => {}, reads: createReadStore(drizzle(pg), network) },
    { store: auth, uri: "https://waffle.local" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    network,
  );
const app = scoped("mainnet");
app.route("/networks/devnet", scoped("devnet"));
app.route("/networks/testnet", scoped("testnet"));
beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("../../../packages/db/migrations", import.meta.url).pathname,
  });
  await pg.exec("CREATE ROLE network_test_login LOGIN INHERIT NOBYPASSRLS; GRANT waffle_api TO network_test_login");
  await pg.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2)", [owner, WRAPPED_SOL_MINT]);
  await pg.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,now()+interval '1 day')", [
    owner,
    hashSecret(token),
  ]);
});
afterAll(async () => {
  await pg?.close();
});

test("one session works on all network endpoints and Testnet reports actual trading availability", async () => {
  for (const prefix of ["", "/networks/devnet", "/networks/testnet"]) {
    expect((await app.request(`${prefix}/auth/session`, { headers })).status).toBe(200);
    expect((await app.request(`${prefix}/health`)).status).toBe(200);
  }
  const response = await app.request("/networks/testnet/network");
  expect(await response.json()).toMatchObject({ network: "testnet", signIn: true, pumpSwap: false, realTrades: false });
});

test("tracking the same address on two networks creates distinct wallets and follows", async () => {
  const ids: string[] = [];
  for (const prefix of ["", "/networks/devnet"]) {
    const response = await app.request(`${prefix}/wallets`, {
      method: "POST",
      headers,
      body: JSON.stringify({ address: trackedAddress }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { wallet: { id: string } };
    ids.push(body.wallet.id);
    const own = await app.request(`${prefix}/wallet-subscriptions`, { headers });
    expect(await own.json()).toMatchObject({ items: [{ walletId: body.wallet.id }] });
  }
  expect(ids[0]).not.toBe(ids[1]);
  const [mainId, devnetId] = ids;
  if (!mainId || !devnetId) throw new Error("Missing wallet fixture");
  const devnet = createReadStore(drizzle(pg), "devnet");
  expect((await devnet.wallets()).items.map((w) => w.id)).toEqual([devnetId]);
  await auth.withSession(hashSecret(token), async (tx, session) => {
    expect(await createSubscriptionStore(tx, session.userId, "devnet").put(mainId, {})).toEqual({
      status: "not-found",
    });
    expect(await createWalletTrackingStore(tx, session.userId, "devnet").remove(mainId)).toEqual({
      status: "not-tracked",
    });
    await createSubscriptionStore(tx, session.userId, "devnet").remove(mainId);
    expect((await createSubscriptionStore(tx, session.userId).list()).items).toHaveLength(1);
  });
});

test("public reads, Following and live delivery exclude other networks; cross-network trade IDs cannot be used", async () => {
  const mainWallet = crypto.randomUUID(),
    devWallet = crypto.randomUUID(),
    mainSignal = crypto.randomUUID(),
    devSignal = crypto.randomUUID();
  await pg.query(
    "INSERT INTO watched_wallets(id,address,label,inclusion_reason,network) VALUES($1,$2,'main','fixture','mainnet'),($3,$2,'dev','fixture','devnet')",
    [mainWallet, SPL_TOKEN_PROGRAM_ID, devWallet],
  );
  const scored = scoreSignal({
    mintAddress: PUMP_SWAP_PROGRAM_ID,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: 123,
    currentSlot: 123,
    observedAtMs: Date.now(),
    nowMs: Date.now(),
    mint: null,
    pool: null,
    quote: null,
    holders: null,
    creator: null,
    oracle: null,
  });
  const snapshot = {
    transactionSlot: 123,
    currentSlot: 123,
    mint: null,
    pool: null,
    quote: null,
    holders: null,
    creator: null,
    oracle: null,
  };
  for (const [id, wallet] of [
    [mainSignal, mainWallet],
    [devSignal, devWallet],
  ]) {
    await pg.query(
      "INSERT INTO signals(id,signature,wallet_id,mint_address,source_program_id,slot,observed_at,score_version,score,status,data_status,reasons,snapshot) VALUES($1,$2,$3,$4,$4,123,now(),1,$5,'suppressed','unknown',$6,$7)",
      [
        id,
        "1".repeat(64),
        wallet,
        PUMP_SWAP_PROGRAM_ID,
        scored.score,
        JSON.stringify(scored.reasons),
        JSON.stringify(snapshot),
      ],
    );
    await pg.query("INSERT INTO signal_events(signal_id) VALUES($1)", [id]);
    await pg.query("INSERT INTO user_wallet_subscriptions(user_id,watched_wallet_id) VALUES($1,$2)", [owner, wallet]);
  }
  for (const [network, signal] of [
    ["mainnet", mainSignal],
    ["devnet", devSignal],
  ] as const) {
    const reads = createReadStore(drizzle(pg), network);
    expect((await reads.signals({ view: "all", direction: "before", limit: 50 })).items.map((item) => item.id)).toEqual(
      [signal],
    );
    await auth.withSession(hashSecret(token), async (tx, session) => {
      expect(
        (
          await createReadStore(tx, network).signals(
            { view: "following", direction: "before", limit: 50 },
            session.userId,
          )
        ).items.map((item) => item.id),
      ).toEqual([signal]);
    });
    const page = await createLiveReadStore(drizzle(pg), network).page(null);
    expect(page.events.map((event) => event.signalId)).toEqual([signal]);
  }
  // Reject at the scoped lookup before decoding a stored snapshot or asking a provider.
  expect(await createReadStore(drizzle(pg), "devnet").signal(mainSignal)).toBeNull();
  const wrongTrade = await app.request("/networks/devnet/trade-attempts", {
    method: "POST",
    headers,
    body: JSON.stringify({ signalId: mainSignal, inputAmountLamports: "10000000" }),
  });
  expect(wrongTrade.status).toBe(404);
  const position = crypto.randomUUID(),
    attempt = crypto.randomUUID();
  await pg.query(
    "INSERT INTO paper_positions(id,user_id,signal_id,size_lamports,entry_quote) VALUES($1,$2,$3,10000000,'{}')",
    [position, owner, mainSignal],
  );
  await pg.query(
    "INSERT INTO trade_attempts(id,user_id,signal_id,quote_id,request_id,taker,router,input_amount_lamports) VALUES($1,$2,$3,$4,'network-test',$5,'metis',10000000)",
    [attempt, owner, mainSignal, crypto.randomUUID(), WRAPPED_SOL_MINT],
  );
  await auth.withSession(hashSecret(token), async (tx, session) => {
    expect(await createPaperPositionStore(tx, session.userId, "devnet").get(position)).toBeNull();
    expect(await createTradeAttemptStore(tx, session.userId, "devnet").get(attempt)).toBeNull();
    expect((await createTradeAttemptStore(tx, session.userId, "devnet").list({ limit: 50 }))?.items).toEqual([]);
  });
});
