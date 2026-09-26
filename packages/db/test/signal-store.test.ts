import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  PUMP_SWAP_PROGRAM_ID,
  type ScoredSignal,
  SPL_TOKEN_PROGRAM_ID,
  scoreSignal,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type SignalQuery, type SignalTransaction, storeSignal } from "../src/signal-store.ts";

const wallet = WRAPPED_SOL_MINT;
const secondWallet = SPL_TOKEN_PROGRAM_ID;
const mint = "8Vte25yt28L8BfLXm8DrzjSYEyaKX8yry6hRKRmX7FGd";
const signature = "4CXDvKkXcbuKJnW3awqVjuxKWj467mg9rgjc74kdWRFAn2NmqbegZdvsQbpEzxRRApYM7kTyXVzDQbjZFPr2nBBb";
const now = 1_800_000_000_000;
const iso = new Date(now).toISOString();
let pg: PGlite;
const transaction: SignalTransaction = (run) =>
  pg.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE waffle_watcher");
    const query: SignalQuery = async <T extends Record<string, unknown>>(
      sql: string,
      parameters: (string | number)[] = [],
    ) => (await tx.query<T>(sql, parameters)).rows;
    return run(query);
  });
function signal(address = wallet): ScoredSignal {
  const result = scoreSignal({
    mintAddress: mint,
    supportedBuy: true,
    transactionSucceeded: true,
    transactionSlot: 100,
    currentSlot: 101,
    observedAtMs: now,
    nowMs: now,
    mint: {
      address: mint,
      tokenProgramId: SPL_TOKEN_PROGRAM_ID,
      mintAuthority: null,
      freezeAuthority: null,
      fetchedAtMs: now,
    },
    pool: { baseMint: mint, quoteMint: WRAPPED_SOL_MINT, liquidityUsd: 100_000, fetchedAtMs: now },
    quote: {
      inputMint: WRAPPED_SOL_MINT,
      outputMint: mint,
      inputLamports: 50_000_000n,
      outputAmountRaw: 123n,
      fetchedAtMs: now,
    },
    holders: null,
    creator: null,
    oracle: null,
  });
  const fresh = { status: "fresh" as const, expiresAt: new Date(now + 10_000).toISOString(), reason: null };
  const unknown = { status: "unknown" as const, expiresAt: null, reason: "unavailable" };
  return {
    signature,
    walletAddress: address,
    mintAddress: mint,
    sourceProgramId: PUMP_SWAP_PROGRAM_ID,
    slot: 100,
    observedAt: iso,
    scoreVersion: 1,
    score: result.score,
    status: result.status,
    dataStatus: "partial",
    reasons: [...result.reasons],
    snapshot: {
      transactionSlot: 100,
      currentSlot: 101,
      mint: {
        address: mint,
        tokenProgramId: SPL_TOKEN_PROGRAM_ID,
        mintAuthority: null,
        freezeAuthority: null,
        fetchedAt: iso,
      },
      pool: { baseMint: mint, quoteMint: WRAPPED_SOL_MINT, liquidityUsd: 100_000, fetchedAt: iso },
      quote: {
        inputMint: WRAPPED_SOL_MINT,
        outputMint: mint,
        inputLamports: "50000000",
        outputAmountRaw: "123",
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
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await migrate(drizzle(pg), { migrationsFolder: "./migrations" });
  await pg.query(
    "INSERT INTO watched_wallets (address, label, inclusion_reason) VALUES ($1, 'First', 'Fixture'), ($2, 'Second', 'Fixture')",
    [wallet, secondWallet],
  );
});
beforeEach(async () => {
  await pg.exec(
    "TRUNCATE signals CASCADE; UPDATE watched_wallets SET active = true, recent_supported_activity_at = NULL",
  );
});
afterAll(async () => {
  await pg?.close();
});
async function counts() {
  return (
    await pg.query(
      "SELECT (SELECT count(*)::int FROM signals) AS signals, (SELECT count(*)::int FROM signal_events) AS events",
    )
  ).rows[0];
}

describe("restricted watcher signal persistence", () => {
  test("persists one complete signal and outbox row, then preserves the first snapshot on duplicate", async () => {
    const original = signal();
    const first = await storeSignal(transaction, wallet, () => original);
    expect(first.status).toBe("inserted");
    const duplicate = signal();
    if (!original.snapshot.quote) throw new Error("Expected quote");
    duplicate.snapshot.quote = { ...original.snapshot.quote, outputAmountRaw: "999" };
    expect(await storeSignal(transaction, wallet, () => duplicate)).toEqual({ status: "duplicate" });
    expect(await counts()).toEqual({ signals: 1, events: 1 });
    const [row] = (
      await pg.query("SELECT score_version, score, reasons, snapshot, slot, status, data_status FROM signals")
    ).rows;
    expect(row).toMatchObject({
      score_version: 1,
      score: 80,
      slot: 100,
      status: "eligible",
      data_status: "partial",
      reasons: original.reasons,
      snapshot: original.snapshot,
    });
  });

  test("concurrent retries share one signature/wallet entry but another wallet is independent", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => storeSignal(transaction, wallet, () => signal())),
    );
    expect(results.filter((result) => result.status === "inserted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "duplicate")).toHaveLength(4);
    expect((await storeSignal(transaction, secondWallet, () => signal(secondWallet))).status).toBe("inserted");
    expect(await counts()).toEqual({ signals: 2, events: 2 });
  });

  test("outbox failure rolls back the signal and activity update; retry can succeed", async () => {
    await pg.exec(`CREATE FUNCTION fail_signal_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$;
      CREATE TRIGGER fail_signal_event BEFORE INSERT ON signal_events FOR EACH ROW EXECUTE FUNCTION fail_signal_event()`);
    try {
      await expect(storeSignal(transaction, wallet, () => signal())).rejects.toThrow("forced outbox failure");
      expect(await counts()).toEqual({ signals: 0, events: 0 });
      expect(
        (await pg.query("SELECT recent_supported_activity_at FROM watched_wallets WHERE address = $1", [wallet]))
          .rows[0],
      ).toEqual({ recent_supported_activity_at: null });
    } finally {
      await pg.exec("DROP TRIGGER fail_signal_event ON signal_events; DROP FUNCTION fail_signal_event()");
    }
    expect((await storeSignal(transaction, wallet, () => signal())).status).toBe("inserted");
    expect(await counts()).toEqual({ signals: 1, events: 1 });
  });

  test("paused and removed catalog wallets cannot persist a queued signal", async () => {
    await pg.query("UPDATE watched_wallets SET active = false WHERE address = $1", [wallet]);
    let called = false;
    expect(
      await storeSignal(transaction, wallet, () => {
        called = true;
        return signal();
      }),
    ).toEqual({ status: "inactive-wallet" });
    expect(await storeSignal(transaction, mint, () => signal(mint))).toEqual({ status: "inactive-wallet" });
    expect(called).toBe(false);
    expect(await counts()).toEqual({ signals: 0, events: 0 });
  });

  test("assessment occurs after both locks and older backfills never lower catalog activity", async () => {
    let prepared = false;
    const ordered: SignalTransaction = (run) =>
      transaction((query) =>
        run(async (sql, params) => {
          if (sql.includes("pg_advisory_xact_lock") || sql.includes("FOR SHARE")) expect(prepared).toBe(false);
          return query(sql, params);
        }),
      );
    await storeSignal(ordered, wallet, () => {
      prepared = true;
      return signal();
    });
    const old = signal();
    old.signature = "5nMyRvg6LmK7hJ8zetUYYMEK6WcCPpLPg8U1HdmafxuTaKWy48ggE1zZ3AZ7tUMQaRmPhXjZLRfYwUsGDUaLtzoE";
    if (!old.snapshot.assessment) throw new Error("Expected assessment");
    old.snapshot.assessment.transactionAt = new Date(now - 1000).toISOString();
    await storeSignal(transaction, wallet, () => old);
    const [row] = (
      await pg.query<{ recent_supported_activity_at: Date }>(
        "SELECT recent_supported_activity_at FROM watched_wallets WHERE address = $1",
        [wallet],
      )
    ).rows;
    expect(row?.recent_supported_activity_at.toISOString()).toBe(iso);
  });

  test("invalid score contracts and mismatched wallets roll back", async () => {
    const invalid = signal();
    invalid.score = 100;
    await expect(storeSignal(transaction, wallet, () => invalid)).rejects.toThrow();
    await expect(storeSignal(transaction, wallet, () => signal(secondWallet))).rejects.toThrow(
      "Signal wallet mismatch",
    );
    expect(await counts()).toEqual({ signals: 0, events: 0 });
  });
});
