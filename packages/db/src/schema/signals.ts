import type { ScoreReasonDto, ScoreSnapshot } from "@waffle/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
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
import { watchedWallets } from "./catalog.ts";
import { createdAt } from "./columns.ts";

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signature: varchar("signature", { length: 88 }).notNull(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => watchedWallets.id, { onDelete: "restrict" }),
    mintAddress: varchar("mint_address", { length: 44 }).notNull(),
    sourceProgramId: varchar("source_program_id", { length: 44 }).notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    scoreVersion: integer("score_version").notNull(),
    score: integer("score").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    dataStatus: varchar("data_status", { length: 20 }).notNull(),
    reasons: jsonb("reasons").$type<ScoreReasonDto[]>().notNull(),
    snapshot: jsonb("snapshot").$type<ScoreSnapshot>().notNull(),
  },
  (table) => [
    uniqueIndex("signals_signature_wallet_unique").on(table.signature, table.walletId),
    index("signals_wallet_published_idx").on(table.walletId, table.publishedAt),
    check("signals_slot_nonnegative_check", sql`${table.slot} >= 0`),
    check("signals_score_range_check", sql`${table.score} BETWEEN 0 AND 100`),
    check("signals_score_version_check", sql`${table.scoreVersion} > 0`),
    check("signals_status_check", sql`${table.status} IN ('eligible', 'history-only', 'suppressed')`),
    check("signals_data_status_check", sql`${table.dataStatus} IN ('complete', 'partial', 'stale', 'unknown')`),
  ],
);

export const signalEvents = pgTable(
  "signal_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    pushExpandedAt: timestamp("push_expanded_at", { withTimezone: true }),
    liveDispatchedAt: timestamp("live_dispatched_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("signal_events_signal_unique").on(table.signalId),
    index("signal_events_push_pending_idx").on(table.id).where(sql`${table.pushExpandedAt} IS NULL`),
  ],
);
