import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Shared query-builder surface for postgres.js, PGlite, and their transactions. */
export type DatabaseExecutor = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update" | "delete" | "execute" | "$with" | "with"
>;

export type DatabaseTransaction = <T>(run: (tx: DatabaseExecutor) => Promise<T>) => Promise<T>;
