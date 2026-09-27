import { type ScoredSignal, scoredSignalSchema } from "@waffle/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "./database.ts";
import { signalEvents, signals, watchedWallets } from "./schema/index.ts";

export type SignalWriteResult =
  | { status: "inserted"; signalId: string; eventId: string }
  | { status: "duplicate" }
  | { status: "inactive-wallet" };

/** A short transaction; enrichment happens before this boundary. No update of an existing signal. */
export async function storeSignal(
  transaction: DatabaseTransaction,
  walletAddress: string,
  prepare: () => ScoredSignal,
): Promise<SignalWriteResult> {
  return transaction(async (tx): Promise<SignalWriteResult> => {
    // Shared by all watcher writers, before sequence allocation, so outbox IDs follow commit order.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1970169702, 1)`);
    const [wallet] = await tx
      .select({ id: watchedWallets.id })
      .from(watchedWallets)
      .where(and(eq(watchedWallets.address, walletAddress), eq(watchedWallets.active, true)))
      .for("share");
    if (!wallet) return { status: "inactive-wallet" };
    const signal = scoredSignalSchema.parse(prepare());
    if (signal.walletAddress !== walletAddress) throw new Error("Signal wallet mismatch");
    const [inserted] = await tx
      .insert(signals)
      .values({
        signature: signal.signature,
        walletId: wallet.id,
        mintAddress: signal.mintAddress,
        sourceProgramId: signal.sourceProgramId,
        slot: signal.slot,
        observedAt: new Date(signal.observedAt),
        publishedAt: sql`clock_timestamp()`,
        scoreVersion: signal.scoreVersion,
        score: signal.score,
        status: signal.status,
        dataStatus: signal.dataStatus,
        reasons: signal.reasons,
        snapshot: signal.snapshot,
      })
      .onConflictDoNothing({ target: [signals.signature, signals.walletId] })
      .returning({ id: signals.id });
    if (!inserted) return { status: "duplicate" };
    const [event] = await tx
      .insert(signalEvents)
      .values({ signalId: inserted.id, createdAt: sql`clock_timestamp()` })
      .returning({ id: signalEvents.id });
    if (!event) throw new Error("Signal outbox insert failed");
    // Backfills must never move the catalog activity timestamp backwards.
    const transactionAt = signal.snapshot.assessment?.transactionAt;
    if (transactionAt)
      await tx
        .update(watchedWallets)
        .set({
          recentSupportedActivityAt: sql`GREATEST(${watchedWallets.recentSupportedActivityAt}, ${transactionAt}::timestamptz)`,
        })
        .where(eq(watchedWallets.id, wallet.id));
    return { status: "inserted", signalId: inserted.id, eventId: event.id.toString() };
  });
}
