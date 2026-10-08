import {
  type GetSignalsQuery,
  signalDetailSchema,
  signalPageSchema,
  walletCatalogResponseSchema,
} from "@waffle/shared";
import { and, asc, desc, eq, exists, gt, lt, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./database.ts";
import { signalEvents, signals, userWalletSubscriptions, watchedWallets } from "./schema/index.ts";

const summaryColumns = {
  id: signals.id,
  eventId: sql<string>`${signalEvents.id}::text`.as("event_id"),
  signature: signals.signature,
  walletId: signals.walletId,
  walletAddress: watchedWallets.address,
  mintAddress: signals.mintAddress,
  sourceProgramId: signals.sourceProgramId,
  slot: signals.slot,
  observedAt: signals.observedAt,
  publishedAt: signals.publishedAt,
  scoreVersion: signals.scoreVersion,
  score: signals.score,
  status: signals.status,
  dataStatus: signals.dataStatus,
};

function serializeSignal<T extends { observedAt: Date; publishedAt: Date }>(row: T) {
  return { ...row, observedAt: row.observedAt.toISOString(), publishedAt: row.publishedAt.toISOString() };
}

export class CursorExpiredError extends Error {
  constructor() {
    super("Cursor is older than retained signal history");
  }
}

/** Public reads use the API login; Following must receive the authenticated transaction and owner. */
export function createReadStore(db: DatabaseExecutor, network: import("@waffle/shared").SolanaNetwork = "mainnet") {
  return {
    async wallets() {
      const rows = await db
        .select({
          id: watchedWallets.id,
          address: watchedWallets.address,
          label: watchedWallets.label,
          active: watchedWallets.active,
          source: watchedWallets.source,
          inclusionReason: watchedWallets.inclusionReason,
          recentSupportedActivityAt: watchedWallets.recentSupportedActivityAt,
        })
        .from(watchedWallets)
        .where(eq(watchedWallets.network, network))
        .orderBy(watchedWallets.label, watchedWallets.id)
        .limit(101);
      return walletCatalogResponseSchema.parse({
        items: rows.map((row) => ({
          ...row,
          recentSupportedActivityAt: row.recentSupportedActivityAt?.toISOString() ?? null,
        })),
      });
    },
    async signals(input: GetSignalsQuery, ownerId?: string) {
      if (input.view === "following" && !ownerId) throw new Error("Following requires an authenticated owner");
      const order = input.direction === "before" ? desc : asc;
      const compare = input.direction === "before" ? lt : gt;
      const pageRows = db
        .select(summaryColumns)
        .from(signalEvents)
        .innerJoin(signals, eq(signals.id, signalEvents.signalId))
        .innerJoin(watchedWallets, eq(watchedWallets.id, signals.walletId))
        .where(
          and(
            eq(watchedWallets.network, network),
            input.cursor ? compare(signalEvents.id, BigInt(input.cursor)) : undefined,
            input.walletId ? eq(signals.walletId, input.walletId) : undefined,
            // The public All feed stays curated: user-added wallets surface only via Following.
            input.view === "all" ? eq(watchedWallets.source, "catalog") : undefined,
            input.view === "following" && ownerId
              ? exists(
                  db
                    .select({ walletId: userWalletSubscriptions.watchedWalletId })
                    .from(userWalletSubscriptions)
                    .where(
                      and(
                        eq(userWalletSubscriptions.watchedWalletId, signals.walletId),
                        eq(userWalletSubscriptions.userId, ownerId),
                      ),
                    ),
                )
              : undefined,
          ),
        )
        .orderBy(order(signalEvents.id))
        .limit(input.limit + 1)
        .as("page");
      const bounds = db.$with("bounds").as(
        db
          .select({
            oldest: sql<string | null>`min(${signalEvents.id})::text`.as("oldest"),
          })
          .from(signalEvents),
      );
      // One statement keeps retention bounds and page rows on the same database snapshot.
      const rows = await db
        .with(bounds)
        .select()
        .from(bounds)
        .leftJoinLateral(pageRows, sql`true`)
        .orderBy(order(sql`${pageRows.eventId}::bigint`));
      const oldest = rows[0]?.bounds.oldest;
      if (input.cursor && (!oldest || BigInt(input.cursor) < BigInt(oldest))) throw new CursorExpiredError();
      const items = rows.flatMap((row) => (row.page ? [serializeSignal(row.page)] : []));
      const page = signalPageSchema.parse({
        view: input.view,
        direction: input.direction,
        items: items.slice(0, input.limit),
        nextCursor: null,
        hasMore: items.length > input.limit,
      });
      // The last applied event also remains useful for reconnect when this page is terminal.
      page.nextCursor = page.items.at(-1)?.eventId ?? null;
      return page;
    },
    async signal(id: string) {
      const [row] = await db
        .select({ ...summaryColumns, reasons: signals.reasons, snapshot: signals.snapshot })
        .from(signalEvents)
        .innerJoin(signals, eq(signals.id, signalEvents.signalId))
        .innerJoin(watchedWallets, eq(watchedWallets.id, signals.walletId))
        .where(and(eq(signals.id, id), eq(watchedWallets.network, network)));
      return row ? signalDetailSchema.parse(serializeSignal(row)) : null;
    },
  };
}

export type ReadStore = ReturnType<typeof createReadStore>;
