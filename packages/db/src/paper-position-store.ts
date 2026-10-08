import {
  calculatePaperFill,
  type GetPaperPositionsQuery,
  type PaperQuote,
  paperPositionsResponseSchema,
  paperPositionWithFillSchema,
} from "@waffle/shared";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./database.ts";
import { paperPositions } from "./schema/index.ts";

function serialize(row: typeof paperPositions.$inferSelect) {
  return paperPositionWithFillSchema.parse({
    id: row.id,
    signalId: row.signalId,
    sizeLamports: row.sizeLamports.toString(),
    entryQuote: row.entryQuote,
    simulated: row.simulated,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    fill: calculatePaperFill(row.entryQuote, row.createdAt.getTime()),
  });
}

/** Only call inside the authenticated owner's transaction. */
export function createPaperPositionStore(
  tx: DatabaseExecutor,
  userId: string,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  return {
    async get(id: string) {
      const [row] = await tx
        .select()
        .from(paperPositions)
        .where(and(eq(paperPositions.id, id), eq(paperPositions.userId, userId), eq(paperPositions.network, network)));
      return row ? serialize(row) : null;
    },
    async byQuote(quoteId: string) {
      const [row] = await tx
        .select()
        .from(paperPositions)
        .where(
          and(
            eq(paperPositions.userId, userId),
            eq(paperPositions.network, network),
            sql`${paperPositions.entryQuote} ->> 'id' = ${quoteId}`,
          ),
        )
        .limit(1);
      return row ? serialize(row) : null;
    },
    async create(quote: PaperQuote, filledAtMs: number) {
      const [row] = await tx
        .insert(paperPositions)
        .values({
          userId,
          network,
          signalId: quote.signalId,
          sizeLamports: BigInt(quote.inputAmountLamports),
          entryQuote: quote,
          simulated: true,
          status: "open",
          createdAt: new Date(filledAtMs),
        })
        .returning();
      if (!row) throw new Error("Paper position insert failed");
      return serialize(row);
    },
    async list(input: GetPaperPositionsQuery) {
      const [cursor] = input.cursor
        ? await tx
            .select()
            .from(paperPositions)
            .where(
              and(
                eq(paperPositions.id, input.cursor),
                eq(paperPositions.userId, userId),
                eq(paperPositions.network, network),
              ),
            )
        : [];
      if (input.cursor && !cursor) return null;
      const rows = await tx
        .select()
        .from(paperPositions)
        .where(
          and(
            eq(paperPositions.userId, userId),
            eq(paperPositions.network, network),
            cursor
              ? or(
                  lt(paperPositions.createdAt, cursor.createdAt),
                  and(eq(paperPositions.createdAt, cursor.createdAt), lt(paperPositions.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(paperPositions.createdAt), desc(paperPositions.id))
        .limit(input.limit + 1);
      const items = rows.slice(0, input.limit).map(serialize);
      return paperPositionsResponseSchema.parse({
        items,
        nextCursor: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
      });
    },
  };
}
