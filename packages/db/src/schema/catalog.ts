import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt } from "./columns.ts";

export const watchedWallets = pgTable(
  "watched_wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    network: varchar("network", { length: 16 }).$type<"mainnet" | "devnet" | "testnet">().default("mainnet").notNull(),
    address: varchar("address", { length: 44 }).notNull(),
    label: varchar("label", { length: 80 }).notNull(),
    active: boolean("active").default(true).notNull(),
    /** 'catalog' = curated seed; 'user' = added by a user for personal tracking. */
    source: varchar("source", { length: 16 }).default("catalog").notNull(),
    inclusionReason: text("inclusion_reason").notNull(),
    recentSupportedActivityAt: timestamp("recent_supported_activity_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("watched_wallets_network_address_unique").on(table.network, table.address),
    check("watched_wallets_network_check", sql`${table.network} IN ('mainnet', 'devnet', 'testnet')`),
    check("watched_wallets_source_check", sql`${table.source} IN ('catalog', 'user')`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletAddress: varchar("wallet_address", { length: 44 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("users_wallet_address_unique").on(table.walletAddress)],
);

/** Which users added a wallet to tracking. Caps per user and decides when to pause an unused wallet. */
export const userTrackedWallets = pgTable(
  "user_tracked_wallets",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    watchedWalletId: uuid("watched_wallet_id")
      .notNull()
      .references(() => watchedWallets.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.watchedWalletId] }),
    index("user_tracked_wallets_wallet_idx").on(table.watchedWalletId),
  ],
);

export const userWalletSubscriptions = pgTable(
  "user_wallet_subscriptions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    watchedWalletId: uuid("watched_wallet_id")
      .notNull()
      .references(() => watchedWallets.id, { onDelete: "restrict" }),
    alertsEnabled: boolean("alerts_enabled").default(false).notNull(),
    alertsEnabledAt: timestamp("alerts_enabled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.watchedWalletId] }),
    index("user_wallet_subscriptions_wallet_idx").on(table.watchedWalletId),
    check(
      "user_wallet_subscriptions_alert_timestamp_check",
      sql`${table.alertsEnabled} = (${table.alertsEnabledAt} IS NOT NULL)`,
    ),
  ],
);
