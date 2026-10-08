import {
  type PutWalletSubscriptionRequest,
  type WalletSubscription,
  walletSubscriptionSchema,
  walletSubscriptionsResponseSchema,
} from "@waffle/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./database.ts";
import { userWalletSubscriptions as subscriptions, watchedWallets } from "./schema/index.ts";

const columns = {
  walletId: subscriptions.watchedWalletId,
  alertsEnabled: subscriptions.alertsEnabled,
  alertsEnabledAt: subscriptions.alertsEnabledAt,
  createdAt: subscriptions.createdAt,
};

function serializeSubscription(row: {
  walletId: string;
  alertsEnabled: boolean;
  alertsEnabledAt: Date | null;
  createdAt: Date;
}) {
  return {
    ...row,
    alertsEnabledAt: row.alertsEnabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

type FollowResult = { status: "ok"; subscription: WalletSubscription } | { status: "not-found" | "paused" };

/** Use only the database transaction and user ID supplied by an authenticated owner operation. */
export function createSubscriptionStore(
  tx: DatabaseExecutor,
  userId: string,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  return {
    async list() {
      const rows = await tx
        .select(columns)
        .from(subscriptions)
        .innerJoin(watchedWallets, eq(watchedWallets.id, subscriptions.watchedWalletId))
        .where(and(eq(subscriptions.userId, userId), eq(watchedWallets.network, network)))
        .orderBy(subscriptions.createdAt, subscriptions.watchedWalletId)
        .limit(101);
      return walletSubscriptionsResponseSchema.parse({ items: rows.map(serializeSubscription) });
    },
    async put(walletId: string, input: PutWalletSubscriptionRequest): Promise<FollowResult> {
      const [wallet] = await tx
        .select({ active: watchedWallets.active })
        .from(watchedWallets)
        .where(and(eq(watchedWallets.id, walletId), eq(watchedWallets.network, network)));
      if (!wallet) return { status: "not-found" };
      const preference = {
        alertsEnabled: input.alertsEnabled ?? subscriptions.alertsEnabled,
        alertsEnabledAt:
          input.alertsEnabled === undefined
            ? subscriptions.alertsEnabledAt
            : input.alertsEnabled
              ? sql`CASE WHEN ${subscriptions.alertsEnabled} THEN ${subscriptions.alertsEnabledAt} ELSE clock_timestamp() END`
              : null,
      };
      const rows = wallet.active
        ? await tx
            .insert(subscriptions)
            .select(
              tx
                .select({
                  userId: sql<string>`${userId}::uuid`.as("user_id"),
                  watchedWalletId: watchedWallets.id,
                  alertsEnabled: sql<boolean>`${input.alertsEnabled ?? false}::boolean`.as("alerts_enabled"),
                  alertsEnabledAt: (input.alertsEnabled
                    ? sql<Date>`clock_timestamp()`
                    : sql<null>`NULL::timestamptz`
                  ).as("alerts_enabled_at"),
                  createdAt: sql<Date>`clock_timestamp()`.as("created_at"),
                })
                .from(watchedWallets)
                .where(
                  and(
                    eq(watchedWallets.id, walletId),
                    eq(watchedWallets.active, true),
                    eq(watchedWallets.network, network),
                  ),
                ),
            )
            .onConflictDoUpdate({ target: [subscriptions.userId, subscriptions.watchedWalletId], set: preference })
            .returning(columns)
        : // A paused wallet may only update an existing follow, never insert one.
          // Repeated true is allowed only when alerts were already enabled.
          await tx
            .update(subscriptions)
            .set(preference)
            .where(
              and(
                eq(subscriptions.userId, userId),
                eq(subscriptions.watchedWalletId, walletId),
                input.alertsEnabled === true ? eq(subscriptions.alertsEnabled, true) : undefined,
              ),
            )
            .returning(columns);
      const row = rows[0];
      return row
        ? { status: "ok", subscription: walletSubscriptionSchema.parse(serializeSubscription(row)) }
        : { status: "paused" };
    },
    async remove(walletId: string): Promise<void> {
      const [wallet] = await tx
        .select({ id: watchedWallets.id })
        .from(watchedWallets)
        .where(and(eq(watchedWallets.id, walletId), eq(watchedWallets.network, network)));
      if (!wallet) return;
      await tx
        .delete(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.watchedWalletId, walletId)));
    },
  };
}
