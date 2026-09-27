import {
  type GetSignalsQuery,
  signalDetailSchema,
  signalPageSchema,
  walletCatalogResponseSchema,
} from "@waffle/shared";
import type { AuthQuery } from "./auth-store.ts";

const summaryColumns = `s.id, e.id::text AS "eventId", s.signature,
  s.wallet_id AS "walletId", w.address AS "walletAddress", s.mint_address AS "mintAddress",
  s.source_program_id AS "sourceProgramId", s.slot, s.observed_at AS "observedAt",
  s.published_at AS "publishedAt", s.score_version AS "scoreVersion", s.score,
  s.status, s.data_status AS "dataStatus"`;
const signalJoins = `FROM public.signal_events e
  JOIN public.signals s ON s.id = e.signal_id
  JOIN public.watched_wallets w ON w.id = s.wallet_id`;

export class CursorExpiredError extends Error {
  constructor() {
    super("Cursor is older than retained signal history");
  }
}

/** Public reads use the API login; Following must receive the authenticated transaction and owner. */
export function createReadStore(query: AuthQuery) {
  return {
    async wallets() {
      const rows = await query<{ item: unknown }>(
        `SELECT row_to_json(wallet) AS item FROM (
          SELECT id, address, label, active, inclusion_reason AS "inclusionReason",
            recent_supported_activity_at AS "recentSupportedActivityAt"
          FROM public.watched_wallets ORDER BY label, id LIMIT 101
        ) wallet`,
      );
      return walletCatalogResponseSchema.parse({ items: rows.map((row) => row.item) });
    },
    async signals(input: GetSignalsQuery, ownerId?: string) {
      if (input.view === "following" && !ownerId) throw new Error("Following requires an authenticated owner");
      const parameters: string[] = [];
      const bind = (value: string) => {
        parameters.push(value);
        return `$${parameters.length}`;
      };
      const filters: string[] = [];
      const order = input.direction === "before" ? "DESC" : "ASC";
      if (input.cursor) filters.push(`e.id ${input.direction === "before" ? "<" : ">"} ${bind(input.cursor)}::bigint`);
      if (input.walletId) filters.push(`s.wallet_id = ${bind(input.walletId)}::uuid`);
      if (input.view === "following" && ownerId) {
        filters.push(`EXISTS (SELECT 1 FROM public.user_wallet_subscriptions sub
          WHERE sub.watched_wallet_id = s.wallet_id AND sub.user_id = ${bind(ownerId)}::uuid)`);
      }
      // One statement keeps retention bounds and page rows on the same database snapshot.
      // All interpolated SQL is fixed above; every request value is bound as a parameter.
      const rows = await query<{ oldestEventId: string | null; item: unknown }>(
        `WITH bounds AS (SELECT min(id)::text AS oldest FROM public.signal_events)
         SELECT bounds.oldest AS "oldestEventId", row_to_json(page) AS item
         FROM bounds LEFT JOIN LATERAL (
           SELECT ${summaryColumns} ${signalJoins}
           ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
           ORDER BY e.id ${order} LIMIT ${bind(String(input.limit + 1))}::int
         ) page ON true ORDER BY page."eventId"::bigint ${order}`,
        parameters,
      );
      const oldest = rows[0]?.oldestEventId;
      if (input.cursor && (!oldest || BigInt(input.cursor) < BigInt(oldest))) throw new CursorExpiredError();
      const items = rows.map((row) => row.item).filter((item) => item !== null);
      const hasMore = items.length > input.limit;
      const page = signalPageSchema.parse({
        view: input.view,
        direction: input.direction,
        items: items.slice(0, input.limit),
        nextCursor: null,
        hasMore,
      });
      // The last applied event also remains useful for reconnect when this page is terminal.
      page.nextCursor = page.items.at(-1)?.eventId ?? null;
      return page;
    },
    async signal(id: string) {
      const [row] = await query<{ item: unknown }>(
        `SELECT row_to_json(detail) AS item FROM (
          SELECT ${summaryColumns}, s.reasons, s.snapshot ${signalJoins} WHERE s.id = $1::uuid
        ) detail`,
        [id],
      );
      return row ? signalDetailSchema.parse(row.item) : null;
    },
  };
}

export type ReadStore = ReturnType<typeof createReadStore>;
