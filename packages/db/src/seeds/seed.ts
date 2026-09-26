/** Catalog seed entry for issue #7.
 * Usage: bun src/seeds/seed.ts [--apply]
 * Default is a dry run (prints planned rows, writes nothing).
 * --apply upserts into watched_wallets. DB_URL must be the MIGRATION-OWNER
 * direct connection (packages/db/.env) — never an app login (they lack writes). */

import { config as loadDotenv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema/index.ts";
import { CATALOG, seedCatalog } from "./catalog.ts";

async function main(): Promise<void> {
  const apply = Bun.argv.includes("--apply");
  console.log(`[seed] main: mode=${apply ? "APPLY" : "dry-run"} (pass --apply to write)`);
  loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });
  const url = process.env.DB_URL;
  if (typeof url !== "string" || url.includes("replace-me")) {
    throw new Error("DB_URL missing — copy packages/db/.env.example to packages/db/.env first");
  }
  console.log("[seed] main: DB_URL present (value hidden), connecting as migration owner");
  if (!apply) {
    for (const entry of CATALOG) {
      console.log(`[seed] dry-run: ${entry.address} | ${entry.label} | active=true`);
    }
    console.log(`[seed] main: dry-run done — ${CATALOG.length} rows would be upserted, 0 written`);
    return;
  }
  const client = postgres(url, { max: 2, connect_timeout: 10, idle_timeout: 10, prepare: false });
  try {
    const db = drizzle({ client, schema });
    console.log("[seed] main: connected, running seedCatalog");
    await seedCatalog(db);
    console.log("[seed] main: APPLY done — re-run with --apply to prove idempotency (expect no changes)");
  } finally {
    await client.end({ timeout: 5 });
    console.log("[seed] main: connection closed");
  }
}

try {
  await main();
} catch (error) {
  console.error(`[seed] main: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
