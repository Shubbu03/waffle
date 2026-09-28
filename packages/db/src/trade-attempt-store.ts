import {
  type GetTradeAttemptsQuery,
  type JupiterExecutionResult,
  type RealOrder,
  tradeAttemptSchema,
  tradeAttemptsResponseSchema,
} from "@waffle/shared";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./database.ts";
import { tradeAttempts } from "./schema/index.ts";

function serialize(row: typeof tradeAttempts.$inferSelect) {
  return tradeAttemptSchema.parse({
    id: row.id,
    signalId: row.signalId,
    quoteId: row.quoteId,
    requestId: row.requestId,
    taker: row.taker,
    router: row.router,
    inputAmountLamports: row.inputAmountLamports.toString(),
    status: row.status,
    signature: row.signature,
    executeCode: row.executeCode,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Every method requires an authenticated owner transaction; RLS is a second boundary. */
export function createTradeAttemptStore(tx: DatabaseExecutor, userId: string) {
  const owned = (id: string) => and(eq(tradeAttempts.id, id), eq(tradeAttempts.userId, userId));
  return {
    async create(order: RealOrder) {
      const [row] = await tx
        .insert(tradeAttempts)
        .values({
          userId,
          signalId: order.signalId,
          quoteId: order.id,
          requestId: order.requestId,
          taker: order.taker,
          router: order.router,
          inputAmountLamports: BigInt(order.inputAmountLamports),
          status: "prepared",
        })
        .onConflictDoNothing({ target: [tradeAttempts.userId, tradeAttempts.requestId] })
        .returning();
      return row ? serialize(row) : null;
    },
    async get(id: string) {
      const [row] = await tx.select().from(tradeAttempts).where(owned(id));
      return row ? serialize(row) : null;
    },
    async list(input: GetTradeAttemptsQuery) {
      const [cursor] = input.cursor ? await tx.select().from(tradeAttempts).where(owned(input.cursor)) : [];
      if (input.cursor && !cursor) return null;
      const rows = await tx
        .select()
        .from(tradeAttempts)
        .where(
          and(
            eq(tradeAttempts.userId, userId),
            cursor
              ? or(
                  lt(tradeAttempts.createdAt, cursor.createdAt),
                  and(eq(tradeAttempts.createdAt, cursor.createdAt), lt(tradeAttempts.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(tradeAttempts.createdAt), desc(tradeAttempts.id))
        .limit(input.limit + 1);
      const items = rows.slice(0, input.limit).map(serialize);
      return tradeAttemptsResponseSchema.parse({
        items,
        nextCursor: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
      });
    },
    async markSubmitted(id: string, quoteId: string, requestId: string, signature: string) {
      const [row] = await tx
        .update(tradeAttempts)
        .set({
          status: "submitted",
          signature,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            owned(id),
            eq(tradeAttempts.quoteId, quoteId),
            eq(tradeAttempts.requestId, requestId),
            eq(tradeAttempts.status, "prepared"),
          ),
        )
        .returning();
      return row ? serialize(row) : null;
    },
    async reject(id: string, quoteId: string, requestId: string, reason: "WALLET_REJECTED" | "USER_CANCELLED") {
      const [row] = await tx
        .update(tradeAttempts)
        .set({
          status: "wallet_rejected",
          failureReason: reason,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            owned(id),
            eq(tradeAttempts.quoteId, quoteId),
            eq(tradeAttempts.requestId, requestId),
            eq(tradeAttempts.status, "prepared"),
          ),
        )
        .returning();
      if (row) return serialize(row);
      const [existing] = await tx.select().from(tradeAttempts).where(owned(id));
      return existing &&
        existing.quoteId === quoteId &&
        existing.requestId === requestId &&
        existing.status === "wallet_rejected" &&
        existing.failureReason === reason
        ? serialize(existing)
        : null;
    },
    async complete(
      id: string,
      quoteId: string,
      requestId: string,
      signedSignature: string,
      result: JupiterExecutionResult,
    ) {
      const confirmed = result.status === "confirmed" && result.signature === signedSignature;
      const [row] = await tx
        .update(tradeAttempts)
        .set({
          status: confirmed ? "confirmed" : result.status === "failed" ? "failed" : "submitted",
          executeCode: confirmed || result.status === "failed" ? result.code : null,
          failureReason: confirmed
            ? null
            : result.status === "failed"
              ? "JUPITER_EXECUTION_FAILED"
              : "SIGNATURE_MISMATCH",
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            owned(id),
            eq(tradeAttempts.quoteId, quoteId),
            eq(tradeAttempts.requestId, requestId),
            eq(tradeAttempts.signature, signedSignature),
            eq(tradeAttempts.status, "submitted"),
          ),
        )
        .returning();
      return row ? serialize(row) : null;
    },
    async failPrepared(id: string, quoteId: string, requestId: string) {
      const [row] = await tx
        .update(tradeAttempts)
        .set({ status: "failed", failureReason: "ORDER_EXPIRED", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            owned(id),
            eq(tradeAttempts.quoteId, quoteId),
            eq(tradeAttempts.requestId, requestId),
            eq(tradeAttempts.status, "prepared"),
          ),
        )
        .returning();
      return row ? serialize(row) : null;
    },
    async markUnknown(id: string, quoteId: string, requestId: string) {
      const [row] = await tx
        .update(tradeAttempts)
        .set({ failureReason: "EXECUTION_UNKNOWN", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            owned(id),
            eq(tradeAttempts.quoteId, quoteId),
            eq(tradeAttempts.requestId, requestId),
            eq(tradeAttempts.status, "submitted"),
          ),
        )
        .returning();
      return row ? serialize(row) : null;
    },
  };
}
