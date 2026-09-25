import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./catalog.ts";
import { createdAt } from "./columns.ts";

export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nonceHash: varchar("nonce_hash", { length: 64 }).notNull(),
    domain: varchar("domain", { length: 253 }).notNull(),
    uri: text("uri").notNull(),
    version: varchar("version", { length: 8 }).default("1").notNull(),
    chainId: varchar("chain_id", { length: 20 }).notNull(),
    statement: varchar("statement", { length: 300 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("auth_challenges_nonce_hash_unique").on(table.nonceHash),
    index("auth_challenges_expires_idx").on(table.expiresAt),
    check(
      "auth_challenges_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '5 minutes'`,
    ),
    check("auth_challenges_version_check", sql`${table.version} = '1'`),
    check("auth_challenges_chain_check", sql`${table.chainId} IN ('mainnet', 'solana:mainnet')`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
    check(
      "sessions_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
  ],
);
