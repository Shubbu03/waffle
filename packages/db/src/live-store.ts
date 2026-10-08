import { and, asc, desc, eq, exists, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./database.ts";
import { signalEvents, signals, userWalletSubscriptions, watchedWallets } from "./schema/index.ts";

/** Read through the API role, and through an authenticated transaction for Following. */
export function createLiveReadStore(db: DatabaseExecutor, network: import("@waffle/shared").SolanaNetwork = "mainnet") {
  return {
    async page(cursor: string | null, ownerId?: string) {
      const bounds = db.$with("bounds").as(
        db
          .select({
            oldest: sql<string | null>`min(${signalEvents.id})::text`.as("oldest"),
            latest: sql<string | null>`max(${signalEvents.id})::text`.as("latest"),
          })
          .from(signalEvents),
      );
      const page = db
        .select({
          eventId: sql<string>`${signalEvents.id}::text`.as("event_id"),
          signalId: signalEvents.signalId,
          walletId: signals.walletId,
        })
        .from(signalEvents)
        .innerJoin(signals, eq(signals.id, signalEvents.signalId))
        .innerJoin(watchedWallets, eq(watchedWallets.id, signals.walletId))
        .where(
          and(
            eq(watchedWallets.network, network),
            cursor ? gt(signalEvents.id, BigInt(cursor)) : undefined,
            ownerId
              ? exists(
                  db
                    .select({ walletId: userWalletSubscriptions.watchedWalletId })
                    .from(userWalletSubscriptions)
                    .where(
                      and(
                        eq(userWalletSubscriptions.userId, ownerId),
                        eq(userWalletSubscriptions.watchedWalletId, signals.walletId),
                      ),
                    ),
                )
              : // Public All stream stays curated: user-added wallets never broadcast here.
                eq(watchedWallets.source, "catalog"),
          ),
        )
        .orderBy(cursor ? asc(signalEvents.id) : desc(signalEvents.id))
        .limit(cursor ? 51 : 50)
        .as("page");
      // History bounds and events must come from one snapshot, including an empty filtered page.
      const rows = await db
        .with(bounds)
        .select()
        .from(bounds)
        .leftJoinLateral(page, sql`true`)
        .orderBy(cursor ? asc(sql`${page.eventId}::bigint`) : desc(sql`${page.eventId}::bigint`));
      const events = rows.flatMap((row) => (row.page ? [row.page] : []));
      return {
        oldest: rows[0]?.bounds.oldest ?? null,
        latest: rows[0]?.bounds.latest ?? null,
        events: cursor ? events.slice(0, 50) : events.reverse(),
        hasMore: cursor !== null && events.length > 50,
      };
    },
  };
}

/** Only the separate delivery login may record dispatch; API/watcher grants stay unchanged. */
export function createLiveDispatchStore(db: DatabaseExecutor) {
  return {
    async pending() {
      return db
        .select({ id: signalEvents.id })
        .from(signalEvents)
        .where(isNull(signalEvents.liveDispatchedAt))
        .orderBy(signalEvents.id)
        .limit(100);
    },
    async markDispatched(ids: bigint[]) {
      if (ids.length)
        await db
          .update(signalEvents)
          .set({ liveDispatchedAt: sql`clock_timestamp()` })
          .where(and(inArray(signalEvents.id, ids), isNull(signalEvents.liveDispatchedAt)));
    },
  };
}
export type LiveReadStore = ReturnType<typeof createLiveReadStore>;
export type LiveDispatchStore = ReturnType<typeof createLiveDispatchStore>;
export type LivePage = Awaited<ReturnType<LiveReadStore["page"]>>;
