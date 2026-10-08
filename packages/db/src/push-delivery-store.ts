import { and, eq, isNull, lt, lte, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "./database.ts";
import { pushSignal } from "./push-signal.ts";
import {
  pushDeliveries,
  pushTokens,
  signalEvents,
  signals,
  userWalletSubscriptions as subscriptions,
  watchedWallets,
} from "./schema/index.ts";

export type PushMessage = { token: string; expiresAt: number; data: Record<string, string> };
export type PushSendResult =
  | { status: "sent" }
  | { status: "invalid-token" | "failed" | "expired"; code: string }
  | { status: "retry"; code: string; retryAfterMs?: number };
export type PushSender = (message: PushMessage) => Promise<PushSendResult>;
const maxAttempts = 4;

export function createPushDeliveryStore(transaction: DatabaseTransaction, now = Date.now, random = Math.random) {
  return {
    async expandOne() {
      return transaction(async (tx) => {
        const [row] = await tx
          .select({ event: signalEvents, signal: signals, wallet: watchedWallets })
          .from(signalEvents)
          .innerJoin(signals, eq(signals.id, signalEvents.signalId))
          .innerJoin(watchedWallets, eq(watchedWallets.id, signals.walletId))
          .where(isNull(signalEvents.pushExpandedAt))
          .orderBy(signalEvents.id)
          .limit(1)
          .for("update", { of: signalEvents, skipLocked: true });
        if (!row) return false;
        if (row.wallet.active && pushSignal(row.signal, row.wallet.address, row.event.id, now(), row.wallet.network)) {
          await tx
            .insert(pushDeliveries)
            .select(
              tx
                .select({
                  id: sql<string>`gen_random_uuid()`.as("id"),
                  signalEventId: sql<bigint>`${row.event.id.toString()}::bigint`.as("signal_event_id"),
                  pushTokenId: pushTokens.id,
                  status: sql<string>`'pending'::varchar`.as("status"),
                  attempts: sql<number>`0::integer`.as("attempts"),
                  nextAttemptAt: sql<Date>`clock_timestamp()`.as("next_attempt_at"),
                  lastError: sql<string | null>`NULL::text`.as("last_error"),
                  sentAt: sql<Date | null>`NULL::timestamptz`.as("sent_at"),
                  createdAt: sql<Date>`clock_timestamp()`.as("created_at"),
                })
                .from(pushTokens)
                .innerJoin(subscriptions, eq(subscriptions.userId, pushTokens.userId))
                .where(
                  and(
                    eq(subscriptions.watchedWalletId, row.wallet.id),
                    eq(subscriptions.alertsEnabled, true),
                    lt(subscriptions.createdAt, row.event.createdAt),
                    lt(subscriptions.alertsEnabledAt, row.event.createdAt),
                    eq(pushTokens.active, true),
                    eq(pushTokens.notificationPermission, "granted"),
                    lt(pushTokens.createdAt, row.event.createdAt),
                    lt(pushTokens.updatedAt, row.event.createdAt),
                  ),
                ),
            )
            .onConflictDoNothing({ target: [pushDeliveries.signalEventId, pushDeliveries.pushTokenId] });
        }
        await tx
          .update(signalEvents)
          .set({ pushExpandedAt: sql`clock_timestamp()` })
          .where(eq(signalEvents.id, row.event.id));
        return true;
      });
    },
    async deliverOne(send: PushSender) {
      return transaction(async (tx) => {
        const [claimed] = await tx
          .select({ job: pushDeliveries, token: pushTokens })
          .from(pushDeliveries)
          .innerJoin(pushTokens, eq(pushTokens.id, pushDeliveries.pushTokenId))
          .where(and(eq(pushDeliveries.status, "pending"), lte(pushDeliveries.nextAttemptAt, new Date(now()))))
          .orderBy(pushDeliveries.nextAttemptAt, pushDeliveries.id)
          .limit(1)
          .for("update", { of: [pushDeliveries, pushTokens], skipLocked: true });
        if (!claimed) return null;
        // Lock the device with the job; skip devices being revoked rather than deadlocking with cascading deletes.
        const { job, token } = claimed;
        const [row] = await tx
          .select({ event: signalEvents, signal: signals, wallet: watchedWallets, subscription: subscriptions })
          .from(signalEvents)
          .innerJoin(signals, eq(signals.id, signalEvents.signalId))
          .innerJoin(watchedWallets, eq(watchedWallets.id, signals.walletId))
          .leftJoin(
            subscriptions,
            and(eq(subscriptions.userId, token.userId), eq(subscriptions.watchedWalletId, signals.walletId)),
          )
          .where(eq(signalEvents.id, job.signalEventId));
        const payload = row
          ? pushSignal(row.signal, row.wallet.address, row.event.id, now(), row.wallet.network)
          : null;
        const cutoff = row?.event.createdAt.getTime() ?? 0;
        const follow = row?.subscription;
        const eligible =
          payload &&
          token?.active &&
          token.notificationPermission === "granted" &&
          token.createdAt.getTime() < cutoff &&
          token.updatedAt.getTime() < cutoff &&
          row?.wallet.active &&
          follow?.alertsEnabled &&
          follow.createdAt.getTime() < cutoff &&
          follow.alertsEnabledAt &&
          follow.alertsEnabledAt.getTime() < cutoff;
        if (!eligible || !payload || !token || job.attempts >= maxAttempts) {
          await tx
            .update(pushDeliveries)
            .set({ status: "disabled", lastError: "INELIGIBLE" })
            .where(eq(pushDeliveries.id, job.id));
          return "disabled" as const;
        }
        let result: PushSendResult;
        try {
          result = await send({ ...payload, token: token.token });
        } catch {
          result = { status: "retry", code: "TRANSPORT_ERROR" };
        }
        const attempts = job.attempts + 1;
        const updated = {
          attempts,
          sentAt: null as Date | null,
          lastError: null as string | null,
          status: "sent",
          nextAttemptAt: job.nextAttemptAt,
        };
        if (result.status === "sent") updated.sentAt = new Date(now());
        else {
          // Only locally classified codes are persisted; provider bodies may contain tokens.
          updated.lastError = result.code;
          updated.status = result.status === "invalid-token" || result.status === "expired" ? "disabled" : "failed";
          if (result.status === "invalid-token")
            await tx
              .update(pushTokens)
              .set({ active: false, updatedAt: sql`clock_timestamp()` })
              .where(eq(pushTokens.id, token.id));
          if (result.status === "retry") {
            const delay = Math.max(10_000 * 2 ** (attempts - 1) * (1 + random() * 0.25), result.retryAfterMs ?? 0);
            updated.nextAttemptAt = new Date(now() + delay);
            if (attempts < maxAttempts && updated.nextAttemptAt.getTime() < payload.expiresAt)
              updated.status = "pending";
          }
        }
        await tx.update(pushDeliveries).set(updated).where(eq(pushDeliveries.id, job.id));
        return result.status;
      });
    },
  };
}
export type PushDeliveryStore = ReturnType<typeof createPushDeliveryStore>;
