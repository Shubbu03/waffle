import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.ts";
import { users } from "./catalog.ts";
import { signalEvents } from "./signals.ts";

export const pushTokens = pgTable("push_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  token: text("token").notNull(),
  platform: varchar("platform", { length: 16 }).default("android").notNull(),
  notificationPermission: varchar("notification_permission", { length: 16 }).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("push_tokens_token_hash_unique").on(table.tokenHash),
  index("push_tokens_user_idx").on(table.userId),
  check("push_tokens_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check("push_tokens_platform_check", sql`${table.platform} = 'android'`),
  check("push_tokens_permission_check", sql`${table.notificationPermission} IN ('granted', 'denied')`),
]);

export const pushDeliveries = pgTable("push_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  signalEventId: bigint("signal_event_id", { mode: "bigint" }).notNull().references(() => signalEvents.id, { onDelete: "cascade" }),
  pushTokenId: uuid("push_token_id").notNull().references(() => pushTokens.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("push_deliveries_event_token_unique").on(table.signalEventId, table.pushTokenId),
  index("push_deliveries_due_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
  check("push_deliveries_status_check", sql`${table.status} IN ('pending', 'sent', 'failed', 'disabled')`),
  check("push_deliveries_attempts_check", sql`${table.attempts} >= 0`),
  check("push_deliveries_sent_check", sql`${table.status} <> 'sent' OR ${table.sentAt} IS NOT NULL`),
]);
