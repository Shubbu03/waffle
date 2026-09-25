import type { PaperQuote } from "@waffle/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./catalog.ts";
import { createdAt, updatedAt } from "./columns.ts";
import { signals } from "./signals.ts";

export const paperPositions = pgTable(
  "paper_positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "restrict" }),
    sizeLamports: bigint("size_lamports", { mode: "bigint" }).notNull(),
    entryQuote: jsonb("entry_quote").$type<PaperQuote>().notNull(),
    simulated: boolean("simulated").default(true).notNull(),
    status: varchar("status", { length: 16 }).default("open").notNull(),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("paper_positions_user_created_idx").on(table.userId, table.createdAt),
    check("paper_positions_size_check", sql`${table.sizeLamports} > 0 AND ${table.sizeLamports} <= 100000000`),
    check("paper_positions_simulated_check", sql`${table.simulated} = true`),
    check(
      "paper_positions_status_check",
      sql`(${table.status} = 'open' AND ${table.closedAt} IS NULL) OR (${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL)`,
    ),
  ],
);

export const tradeAttempts = pgTable(
  "trade_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "restrict" }),
    quoteId: uuid("quote_id").notNull(),
    requestId: varchar("request_id", { length: 200 }).notNull(),
    taker: varchar("taker", { length: 44 }).notNull(),
    router: varchar("router", { length: 16 }).notNull(),
    inputAmountLamports: bigint("input_amount_lamports", { mode: "bigint" }).notNull(),
    status: varchar("status", { length: 20 }).default("prepared").notNull(),
    signature: varchar("signature", { length: 88 }),
    executeCode: integer("execute_code"),
    failureReason: varchar("failure_reason", { length: 200 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("trade_attempts_user_request_unique").on(table.userId, table.requestId),
    index("trade_attempts_user_created_idx").on(table.userId, table.createdAt),
    check(
      "trade_attempts_size_check",
      sql`${table.inputAmountLamports} > 0 AND ${table.inputAmountLamports} <= 50000000`,
    ),
    check("trade_attempts_router_check", sql`${table.router} IN ('metis', 'dflow', 'okx')`),
    check(
      "trade_attempts_status_check",
      sql`${table.status} IN ('prepared', 'wallet_rejected', 'submitted', 'confirmed', 'failed')`,
    ),
    check(
      "trade_attempts_confirmed_check",
      sql`${table.status} <> 'confirmed' OR (${table.signature} IS NOT NULL AND ${table.executeCode} = 0 AND ${table.failureReason} IS NULL)`,
    ),
  ],
);
