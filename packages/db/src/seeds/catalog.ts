/** Curated wallet catalog seed for issue #7.
 *
 * Five manually reviewed mainnet traders with recent PumpSwap buys, verified
 * on-chain with `bun src/seeds/verify-catalog.ts` (verdicts logged, evidence below).
 * Inclusion reasons are strictly factual: observed swap counts, sampled bodies,
 * failure counts, volume bands. No profitability claims, rankings, or guarantees.
 *
 * Volume bands: low (<=40 recent txs) · mid (<=90) · high (>90, capped 100-tx window).
 */
import { sql } from "drizzle-orm";
import { watchedWallets } from "../schema/catalog.ts";

export type CatalogEntry = {
  address: string;
  label: string;
  inclusionReason: string;
};

export const CATALOG: readonly CatalogEntry[] = [
  {
    address: "5Unf5JaNPJHqWy62MM6f62dGYYY3jKZdzs4oD664nGAH",
    label: "UPTOBER pool trader · 5Unf5",
    inclusionReason:
      "4 PumpSwap buys in 24 sampled bodies (100-tx window, 0 failed); volume band low (27 recent txs). Reviewed 2026-09-26 on mainnet.",
  },
  {
    address: "wrRRFZs8QK6VAXNecVmjN3CbX4Y7kTQAznZdApCza5K",
    label: "UPTOBER pool trader · wrRRF",
    inclusionReason:
      "5 PumpSwap buys in 24 sampled bodies (100-tx window, 0 failed); volume band low (33 recent txs). Reviewed 2026-09-26 on mainnet.",
  },
  {
    address: "7HWkVGmXAdKUGP177gFCSZHv7g9fepw1o6Y8CksRQHwK",
    label: "UPTOBER pool trader · 7HWkV",
    inclusionReason:
      "6 PumpSwap buys in 24 sampled bodies (100-tx window, 0 failed); volume band low (28 recent txs). Reviewed 2026-09-26 on mainnet.",
  },
  {
    address: "31JoETiAGL1MryUgCkZZCx6mhXcRM4mubJkbxMFTnSb8",
    label: "UPTOBER pool trader · 31JoE",
    inclusionReason:
      "5 PumpSwap buys and 1 sell in 24 sampled bodies (100-tx window, 3 failed); volume band mid (82 recent txs). Reviewed 2026-09-26 on mainnet.",
  },
  {
    address: "6sZPir16H1tbo9yzSDDy4sA1aGFWyN2GcrcPpPQ3ZQcv",
    label: "UPTOBER pool trader · 6sZPi",
    inclusionReason:
      "10 PumpSwap buys and 7 sells in 24 sampled bodies (100-tx window, 0 failed); volume band high (100 recent txs, capped window). Reviewed 2026-09-26 on mainnet.",
  },
];

/** Words that must never appear in inclusion reasons (no profit claims, no rankings). */
export const BANNED_REASON_WORDS = [
  "profit",
  "win rate",
  "winrate",
  "guaranteed",
  "guarantee",
  "best",
  "top performer",
  "apy",
  "returns",
  "risk-free",
];

/**
 * Upsert the catalog idempotently: insert missing, refresh label/reason/active on
 * present rows, deactivate (never delete) rows absent from the catalog.
 * Accepts any drizzle pg database (PGlite in tests, postgres-js against Neon here).
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite + postgres-js drizzle both satisfy this at runtime.
export async function seedCatalog(db: any): Promise<{ upserted: number; deactivated: number }> {
  console.log(`[seed] seedCatalog: ${CATALOG.length} entries`);
  let upserted = 0;
  for (const entry of CATALOG) {
    console.log(`[seed] upsert: ${entry.address.slice(0, 8)}... (${entry.label})`);
    await db
      .insert(watchedWallets)
      .values({ address: entry.address, label: entry.label, inclusionReason: entry.inclusionReason, active: true })
      .onConflictDoUpdate({
        target: watchedWallets.address,
        set: { label: entry.label, inclusionReason: entry.inclusionReason, active: true },
      });
    upserted += 1;
  }
  const addresses = CATALOG.map((e) => e.address);
  const deactivated = (await db
    .update(watchedWallets)
    .set({ active: false })
    .where(sql`${watchedWallets.address} NOT IN (${sql.join(addresses.map((a) => sql`${a}`), sql`, `)})`)
    .returning({ id: watchedWallets.id })) as Array<{ id: string }>;
  for (const row of deactivated) console.log(`[seed] deactivate: ${row.id} (removed from catalog, history preserved)`);
  console.log(`[seed] seedCatalog: upserted=${upserted} deactivated=${deactivated.length} (re-run must change nothing)`);
  return { upserted, deactivated: deactivated.length };
}
