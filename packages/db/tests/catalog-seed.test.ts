/** Catalog seed tests for issue #7: idempotent, bounded, factual. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { watchedWallets } from "../src/schema/catalog.ts";
import { BANNED_REASON_WORDS, CATALOG, seedCatalog } from "../src/seeds/catalog.ts";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await migrate(drizzle(pg), { migrationsFolder: "./migrations" });
});

afterAll(async () => {
  await pg?.close();
});

describe("wallet catalog seed", () => {
  test("declares 5-10 wallets with unique valid addresses", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(5);
    expect(CATALOG.length).toBeLessThanOrEqual(10);
    const addresses = CATALOG.map((e) => e.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const address of addresses) {
      expect(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)).toBe(true);
    }
  });

  test("labels fit and reasons carry evidence without banned claims", () => {
    for (const entry of CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeLessThanOrEqual(80);
      expect(entry.inclusionReason.length).toBeGreaterThan(20);
      const lowered = entry.inclusionReason.toLowerCase();
      for (const word of BANNED_REASON_WORDS) {
        expect(lowered.includes(word)).toBe(false);
      }
    }
  });

  test("seed is idempotent: two runs, same rows, none deactivated", async () => {
    const db = drizzle(pg);
    const first = await seedCatalog(db);
    expect(first.upserted).toBe(CATALOG.length);
    expect(first.deactivated).toBe(0);
    const rows = await db.select().from(watchedWallets);
    expect(rows).toHaveLength(CATALOG.length);
    expect(rows.every((r) => r.active)).toBe(true);
    const second = await seedCatalog(db);
    expect(second.upserted).toBe(CATALOG.length);
    expect(second.deactivated).toBe(0);
    const again = await db.select().from(watchedWallets);
    expect(JSON.stringify(again)).toBe(JSON.stringify(rows));
  });

  test("raw duplicate address insert is rejected by the unique index", async () => {
    await expect(
      pg.query("INSERT INTO watched_wallets (address, label, inclusion_reason) VALUES ($1, 'x', 'y')", [
        CATALOG[0]?.address,
      ]),
    ).rejects.toThrow();
  });

  test("removing an entry deactivates instead of deleting", async () => {
    const db = drizzle(pg);
    await pg.query("INSERT INTO watched_wallets (address, label, inclusion_reason) VALUES ($1, 'stale', 'old')", [
      "So11111111111111111111111111111111111111112",
    ]);
    const result = await seedCatalog(db);
    expect(result.deactivated).toBe(1);
    const stale = await pg.query<{ active: boolean }>("SELECT active FROM watched_wallets WHERE address = $1", [
      "So11111111111111111111111111111111111111112",
    ]);
    expect(stale.rows[0]?.active).toBe(false);
    expect(await db.select().from(watchedWallets)).toHaveLength(CATALOG.length + 1);
  });
});
