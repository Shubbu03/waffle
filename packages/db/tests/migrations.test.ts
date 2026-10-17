import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const walletA = "33333333-3333-4333-8333-333333333333";
const signalA = "44444444-4444-4444-8444-444444444444";
const watchedAddress = "So11111111111111111111111111111111111111112";
const otherAddress = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await migrate(drizzle(pg), { migrationsFolder: "./migrations" });
  await pg.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2), ($3, $4)", [
    userA,
    watchedAddress,
    userB,
    otherAddress,
  ]);
  await pg.query(
    "INSERT INTO watched_wallets (id, address, label, inclusion_reason) VALUES ($1, $2, 'Catalog wallet', 'Fixture')",
    [walletA, watchedAddress],
  );
});

afterAll(async () => {
  await pg?.close();
});

describe("initial migration", () => {
  test("creates every planned table and applies role grants plus forced RLS", async () => {
    const result = await pg.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('user_wallet_subscriptions', 'push_tokens', 'paper_positions', 'trade_attempts', 'push_deliveries') ORDER BY c.relname",
    );
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const roles = await pg.query<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname IN ('waffle_api', 'waffle_watcher', 'waffle_delivery')",
    );
    expect(roles.rows).toHaveLength(3);
    expect(roles.rows.every((role) => !role.rolcanlogin && !role.rolbypassrls)).toBe(true);
  });

  test("duplicate signal per signature and wallet is rejected; one outbox row per signal", async () => {
    const args = [signalA, "1".repeat(64), walletA, otherAddress, watchedAddress];
    const insert = `INSERT INTO signals
      (id, signature, wallet_id, mint_address, source_program_id, slot, observed_at, score_version, score, status, data_status, reasons, snapshot)
      VALUES ($1, $2, $3, $4, $5, 350000000, now(), 1, 0, 'suppressed', 'unknown', '[]', '{}')`;
    await pg.query(insert, args);
    await expect(pg.query(insert, ["55555555-5555-4555-8555-555555555555", ...args.slice(1)])).rejects.toThrow();
    const event = await pg.query<{ id: string }>("INSERT INTO signal_events (signal_id) VALUES ($1) RETURNING id", [
      signalA,
    ]);
    expect(event.rows).toHaveLength(1);
    await expect(pg.query("INSERT INTO signal_events (signal_id) VALUES ($1)", [signalA])).rejects.toThrow();
  });

  test("follow defaults alerts off and duplicate user/wallet pair is rejected", async () => {
    const first = await pg.query<{ alerts_enabled: boolean; alerts_enabled_at: Date | null }>(
      "INSERT INTO user_wallet_subscriptions (user_id, watched_wallet_id) VALUES ($1, $2) RETURNING alerts_enabled, alerts_enabled_at",
      [userA, walletA],
    );
    expect(first.rows[0]).toEqual({ alerts_enabled: false, alerts_enabled_at: null });
    await expect(
      pg.query("INSERT INTO user_wallet_subscriptions (user_id, watched_wallet_id) VALUES ($1, $2)", [userA, walletA]),
    ).rejects.toThrow();
    await expect(
      pg.query(
        "INSERT INTO user_wallet_subscriptions (user_id, watched_wallet_id, alerts_enabled) VALUES ($1, $2, true)",
        [userB, walletA],
      ),
    ).rejects.toThrow();
  });

  test("API role denies missing identity and cross-user reads/writes", async () => {
    await pg.exec("SET ROLE waffle_api");
    try {
      const anonymous = await pg.query("SELECT * FROM user_wallet_subscriptions");
      expect(anonymous.rows).toHaveLength(0);
      await expect(
        pg.query("INSERT INTO user_wallet_subscriptions (user_id, watched_wallet_id) VALUES ($1, $2)", [
          userB,
          walletA,
        ]),
      ).rejects.toThrow();

      await pg.exec("BEGIN");
      await pg.query("SELECT set_config('app.user_id', $1, true)", [userA]);
      const ownedToken = await pg.query<{ id: string }>(
        "INSERT INTO push_tokens (user_id, token_hash, token, notification_permission) VALUES ($1, $2, 'owned-device', 'granted') RETURNING id",
        [userA, "b".repeat(64)],
      );
      expect(ownedToken.rows).toHaveLength(1);
      await pg.exec("COMMIT");

      await pg.exec("BEGIN");
      try {
        await pg.query("SELECT set_config('app.user_id', $1, true)", [userA]);
        const mine = await pg.query("SELECT * FROM user_wallet_subscriptions");
        expect(mine.rows).toHaveLength(1);
        await expect(
          pg.query(
            "INSERT INTO push_tokens (user_id, token_hash, token, notification_permission) VALUES ($1, $2, 'other-device', 'granted')",
            [userB, "a".repeat(64)],
          ),
        ).rejects.toThrow();
      } finally {
        await pg.exec("ROLLBACK");
      }
      const afterTransaction = await pg.query("SELECT * FROM user_wallet_subscriptions");
      expect(afterTransaction.rows).toHaveLength(0);
      await expect(pg.query("INSERT INTO signals (id) VALUES (gen_random_uuid())")).rejects.toThrow();
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  test("watcher can return inserted IDs but cannot read auth storage", async () => {
    await pg.exec("SET ROLE waffle_watcher");
    try {
      const inserted = await pg.query<{ id: string }>(
        `INSERT INTO signals
        (signature, wallet_id, mint_address, source_program_id, slot, observed_at, score_version, score, status, data_status, reasons, snapshot)
        VALUES ($1, $2, $3, $4, 350000001, now(), 1, 0, 'suppressed', 'unknown', '[]', '{}')
        RETURNING id`,
        ["2".repeat(64), walletA, otherAddress, watchedAddress],
      );
      expect(inserted.rows).toHaveLength(1);
      const signal = inserted.rows[0];
      if (!signal) throw new Error("Expected inserted signal");
      const outbox = await pg.query<{ id: string }>("INSERT INTO signal_events (signal_id) VALUES ($1) RETURNING id", [
        signal.id,
      ]);
      expect(outbox.rows).toHaveLength(1);
      await expect(pg.query("SELECT * FROM auth_challenges")).rejects.toThrow();
      await expect(pg.query("SELECT * FROM push_tokens")).rejects.toThrow();
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  test("delivery role can disable an invalid token but cannot access auth storage", async () => {
    await pg.exec("SET ROLE waffle_delivery");
    try {
      const disabled = await pg.query<{ active: boolean }>(
        "UPDATE push_tokens SET active = false WHERE token_hash = $1 RETURNING active",
        ["b".repeat(64)],
      );
      expect(disabled.rows).toEqual([{ active: false }]);
      await expect(pg.query("SELECT * FROM sessions")).rejects.toThrow();
    } finally {
      await pg.exec("RESET ROLE");
    }
  });
});

test("payment migration upgrades persisted SOL quotes and restores forced owner isolation", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "waffle-migration-"));
  const old = new PGlite();
  try {
    await mkdir(join(folder, "meta"));
    const journal = JSON.parse(await readFile("./migrations/meta/_journal.json", "utf8"));
    const before = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 5) };
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(before));
    for (const entry of before.entries)
      await copyFile(`./migrations/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`));
    await migrate(drizzle(old), { migrationsFolder: folder });
    await old.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2)", [userA, watchedAddress]);
    await old.query(
      "INSERT INTO watched_wallets (id,address,label,inclusion_reason) VALUES ($1,$2,'Legacy','Legacy')",
      [walletA, watchedAddress],
    );
    await old.query(
      "INSERT INTO signals (id,signature,wallet_id,mint_address,source_program_id,slot,observed_at,score_version,score,status,data_status,reasons,snapshot) VALUES ($1,$2,$3,$4,$5,1,now(),1,0,'suppressed','unknown','[]','{}')",
      [signalA, "1".repeat(64), walletA, otherAddress, watchedAddress],
    );
    const legacy = {
      id: crypto.randomUUID(),
      inputMint: watchedAddress,
      inputAmountLamports: "100000000",
      assessment: { inputAmountLamports: "100000000", policyVersion: 1 },
    };
    await old.query(
      "INSERT INTO paper_positions (user_id,signal_id,size_lamports,entry_quote) VALUES ($1,$2,100000000,$3)",
      [userA, signalA, JSON.stringify(legacy)],
    );
    await migrate(drizzle(old), { migrationsFolder: "./migrations" });
    const migrated = await old.query<{
      entry_quote: {
        inputAmountRaw: string;
        inputAmountLamports?: string;
        assessment: { inputAmountRaw: string; inputMint: string };
      };
      input_mint: string;
    }>("SELECT entry_quote,input_mint FROM paper_positions");
    expect(migrated.rows[0]?.input_mint).toBe(watchedAddress);
    expect(migrated.rows[0]?.entry_quote.inputAmountRaw).toBe("100000000");
    expect(migrated.rows[0]?.entry_quote.inputAmountLamports).toBeUndefined();
    expect(migrated.rows[0]?.entry_quote.assessment).toMatchObject({
      inputMint: watchedAddress,
      inputAmountRaw: "100000000",
    });
    const isolation = await old.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('paper_positions','trade_attempts')",
    );
    expect(isolation.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  } finally {
    await old.close();
    await rm(folder, { recursive: true, force: true });
  }
});
