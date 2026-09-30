import { type AuthStore, createReadStore, createTradeAttemptStore, type DatabaseExecutor } from "@waffle/db";
import {
  type ApiErrorCode,
  type CreateTradeAttemptRequest,
  checkTradeLimits,
  type ExecuteTradeAttemptRequest,
  type GetTradeAttemptsQuery,
  type RealOrder,
  type RejectTradeAttemptRequest,
  realOrderSchema,
  type Session,
  type SignalDetail,
  scorePolicyV1,
  tradeAttemptOrderResponseSchema,
  transactionSignatureSchema,
} from "@waffle/shared";
import bs58 from "bs58";
import { type JupiterService, JupiterServiceError } from "./jupiter.ts";

export class TradeAttemptError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: 401 | 404 | 409 | 503,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

function assertSignal(signal: SignalDetail, inputAmountLamports: string, now: number) {
  const fresh = (value: string | null | undefined, maximum: number) => {
    const age = now - Date.parse(value ?? "");
    return Number.isFinite(age) && age >= 0 && age <= maximum;
  };
  const snapshot = signal.snapshot;
  if (
    signal.status !== "eligible" ||
    signal.score < scorePolicyV1.alertThreshold ||
    !snapshot.assessment ||
    snapshot.assessment.streamStale ||
    !fresh(snapshot.assessment.transactionAt, scorePolicyV1.freshness.signalMs) ||
    !fresh(signal.observedAt, scorePolicyV1.freshness.signalMs) ||
    !fresh(snapshot.mint?.fetchedAt, scorePolicyV1.freshness.mintMs) ||
    !snapshot.pool
  )
    throw new TradeAttemptError("STALE_SIGNAL", 409, "Signal is not eligible for a real order");
  const limit = checkTradeLimits(
    "real",
    BigInt(inputAmountLamports),
    snapshot.pool.liquidityUsd,
    Date.parse(snapshot.pool.fetchedAt),
    now,
  );
  if (!limit.allowed)
    throw new TradeAttemptError(
      limit.reason === "liquidity_stale" ? "STALE_SIGNAL" : "LIMIT_EXCEEDED",
      409,
      "Real size or fresh liquidity requirement not met",
    );
}

function assertOrder(
  order: RealOrder,
  signal: SignalDetail,
  session: Session,
  input: CreateTradeAttemptRequest,
  now: number,
) {
  if (
    order.signalId !== signal.id ||
    order.outputMint !== signal.mintAddress ||
    order.inputAmountLamports !== input.inputAmountLamports ||
    order.taker !== session.walletAddress ||
    order.signatureFeePayer !== session.walletAddress
  )
    throw new TradeAttemptError("CONFLICT", 409, "Order does not match this wallet, signal, and size");
  const age = now - Date.parse(order.fetchedAt);
  if (age < 0 || age >= scorePolicyV1.freshness.quoteMs || now >= Date.parse(order.expiresAt))
    throw new TradeAttemptError("QUOTE_UNAVAILABLE", 409, "Request a fresh real order");
}

function mapJupiter(error: JupiterServiceError): TradeAttemptError {
  if (error.code === "UNSUPPORTED_ORDER")
    return new TradeAttemptError("UNSUPPORTED_ROUTE", 409, "Unsupported wallet route");
  if (error.code === "STALE_ORDER")
    return new TradeAttemptError("QUOTE_UNAVAILABLE", 409, "Request a fresh real order");
  if (error.code === "INVALID_ORDER" || error.code === "INVALID_REQUEST")
    return new TradeAttemptError("CONFLICT", 409, "Order or signed transaction does not match");
  return new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Order or execution service unavailable", error);
}

/** Authenticated wallet is the only source of owner/taker; provider I/O stays outside DB transactions. */
export function createTradeAttemptService(
  auth: AuthStore,
  jupiter?: Pick<JupiterService, "getRealOrder" | "execute">,
  now: () => number = Date.now,
) {
  async function owner<T>(tokenHash: string, run: (tx: DatabaseExecutor, session: Session) => Promise<T>) {
    const result = await auth.withSession(tokenHash, run);
    if (result === null) throw new TradeAttemptError("UNAUTHORIZED", 401, "Valid session required");
    return result;
  }
  async function signalFor(tx: DatabaseExecutor, id: string, amount: string) {
    const signal = await createReadStore(tx).signal(id);
    if (!signal) throw new TradeAttemptError("NOT_FOUND", 404, "Signal not found");
    assertSignal(signal, amount, now());
    return signal;
  }
  return {
    async order(tokenHash: string, input: CreateTradeAttemptRequest) {
      const initial = await owner(tokenHash, async (tx, session) => ({
        signal: await signalFor(tx, input.signalId, input.inputAmountLamports),
        wallet: session.walletAddress,
      }));
      if (!jupiter) throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Real orders are unavailable");
      let order: RealOrder;
      try {
        order = realOrderSchema.parse(
          await jupiter.getRealOrder(
            {
              signalId: input.signalId,
              outputMint: initial.signal.mintAddress,
              inputAmountLamports: input.inputAmountLamports,
              taker: initial.wallet,
            },
            initial.wallet,
          ),
        );
      } catch (error) {
        if (error instanceof JupiterServiceError) throw mapJupiter(error);
        throw error;
      }
      const attempt = await owner(tokenHash, async (tx, session) => {
        const signal = await signalFor(tx, input.signalId, input.inputAmountLamports);
        assertOrder(order, signal, session, input, now());
        const created = await createTradeAttemptStore(tx, session.userId).create(order);
        if (!created) throw new TradeAttemptError("CONFLICT", 409, "Order request already recorded");
        return created;
      });
      return tradeAttemptOrderResponseSchema.parse({ attempt, order });
    },
    async get(tokenHash: string, id: string) {
      return owner(tokenHash, async (tx, session) => {
        const item = await createTradeAttemptStore(tx, session.userId).get(id);
        if (!item) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt not found");
        return item;
      });
    },
    async list(tokenHash: string, query: GetTradeAttemptsQuery) {
      return owner(tokenHash, async (tx, session) => {
        const page = await createTradeAttemptStore(tx, session.userId).list(query);
        if (!page) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt cursor not found");
        return page;
      });
    },
    async reject(tokenHash: string, id: string, input: RejectTradeAttemptRequest) {
      return owner(tokenHash, async (tx, session) => {
        const store = createTradeAttemptStore(tx, session.userId);
        const attempt = await store.get(id);
        if (!attempt) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt not found");
        const result = await store.reject(id, input.quoteId, input.requestId, input.reason);
        if (!result) throw new TradeAttemptError("CONFLICT", 409, "Attempt or order state does not match");
        return result;
      });
    },
    async execute(tokenHash: string, id: string, input: ExecuteTradeAttemptRequest) {
      const attempt = await owner(tokenHash, async (tx, session) => {
        const item = await createTradeAttemptStore(tx, session.userId).get(id);
        if (!item) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt not found");
        if (
          item.status !== "prepared" ||
          item.quoteId !== input.quoteId ||
          item.requestId !== input.requestId ||
          item.taker !== session.walletAddress
        )
          throw new TradeAttemptError("CONFLICT", 409, "Attempt or order state does not match");
        return item;
      });
      if (!jupiter) throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Real execution is unavailable");
      let signedSignature: string | undefined;
      try {
        const result = await jupiter.execute(
          {
            orderId: attempt.quoteId,
            requestId: attempt.requestId,
            signedTransactionBase64: input.signedTransactionBase64,
          },
          attempt.taker,
          async (bytes) => {
            const signature = transactionSignatureSchema.parse(bs58.encode(bytes));
            await owner(tokenHash, async (tx, session) => {
              if (session.walletAddress !== attempt.taker)
                throw new TradeAttemptError("CONFLICT", 409, "Wallet changed");
              const updated = await createTradeAttemptStore(tx, session.userId).markSubmitted(
                id,
                attempt.quoteId,
                attempt.requestId,
                signature,
              );
              if (!updated) throw new TradeAttemptError("CONFLICT", 409, "Attempt already submitted");
              return updated;
            });
            signedSignature = signature;
          },
        );
        const confirmedSignature = signedSignature;
        if (!confirmedSignature || result.requestId !== attempt.requestId)
          throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Execution outcome requires reconciliation");
        const updated = await owner(tokenHash, async (tx, session) => {
          const row = await createTradeAttemptStore(tx, session.userId).complete(
            id,
            attempt.quoteId,
            attempt.requestId,
            confirmedSignature,
            result,
          );
          if (!row) throw new TradeAttemptError("CONFLICT", 409, "Attempt state changed during execution");
          return row;
        });
        if (updated.status === "submitted")
          throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Execution signature requires reconciliation");
        return updated;
      } catch (error) {
        if (error instanceof JupiterServiceError) {
          if (error.code === "EXECUTION_UNKNOWN" && signedSignature) {
            await owner(tokenHash, async (tx, session) =>
              createTradeAttemptStore(tx, session.userId).markUnknown(id, attempt.quoteId, attempt.requestId),
            );
          } else if (error.code === "STALE_ORDER") {
            await owner(tokenHash, async (tx, session) =>
              createTradeAttemptStore(tx, session.userId).failPrepared(id, attempt.quoteId, attempt.requestId),
            );
          }
          throw mapJupiter(error);
        }
        throw error;
      }
    },
  };
}
