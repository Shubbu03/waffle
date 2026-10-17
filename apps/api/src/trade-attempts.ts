import { type AuthStore, createReadStore, createTradeAttemptStore, type DatabaseExecutor } from "@waffle/db";
import {
  type ApiErrorCode,
  type CreateTradeAttemptRequest,
  type ExecuteTradeAttemptRequest,
  type GetTradeAttemptsQuery,
  type JupiterExecutionResult,
  type RealOrder,
  type RejectTradeAttemptRequest,
  realOrderSchema,
  realTradePolicy,
  type Session,
  type SignalDetail,
  tradeAttemptOrderResponseSchema,
  transactionSignatureSchema,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import bs58 from "bs58";
import { type JupiterService, JupiterServiceError } from "./jupiter.ts";
import {
  assertSupportedSignal,
  assertTradeAssessment,
  TradeAssessmentError,
  type TradeAssessor,
} from "./trade-assessment.ts";

export type TradeOrderProvider = Pick<JupiterService, "getRealOrder" | "execute"> & {
  getExecution?(
    signature: string,
    requestId: string,
    taker: string,
    mint: string,
    order?: RealOrder,
  ): Promise<JupiterExecutionResult | null>;
};

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
    order.inputMint !== input.inputMint ||
    order.inputAmountRaw !== input.inputAmountRaw ||
    order.taker !== session.walletAddress ||
    order.signatureFeePayer !== session.walletAddress
  )
    throw new TradeAttemptError("CONFLICT", 409, "Order does not match this wallet, signal, and size");
  const age = now - Date.parse(order.fetchedAt);
  if (
    age < 0 ||
    age >= (order.network === "devnet" ? 60_000 : realTradePolicy.quoteMs) ||
    now >= Date.parse(order.expiresAt)
  )
    throw new TradeAttemptError("QUOTE_UNAVAILABLE", 409, "Request a fresh real order");
}

function mapJupiter(error: JupiterServiceError): TradeAttemptError {
  if (error.upstreamStatus === 429)
    return new TradeAttemptError(
      "SERVICE_UNAVAILABLE",
      503,
      "The quote service is busy. Wait a moment before trying again.",
    );
  if (error.code === "INSUFFICIENT_FUNDS")
    return new TradeAttemptError(
      "QUOTE_UNAVAILABLE",
      409,
      "Your wallet does not have enough of the selected currency for this purchase. Add funds or lower the amount.",
    );
  if (error.code === "INSUFFICIENT_GAS")
    return new TradeAttemptError(
      "QUOTE_UNAVAILABLE",
      409,
      "Your wallet needs more SOL for network fees and token account rent. Add SOL or lower the amount.",
    );
  if (error.code === "ORDER_BUILD_FAILED")
    return new TradeAttemptError(
      "QUOTE_UNAVAILABLE",
      409,
      "The swap service could not build a transaction for this amount. Try another amount or use a paper trade.",
    );
  if (error.code === "UNSUPPORTED_ORDER")
    return new TradeAttemptError(
      "UNSUPPORTED_ROUTE",
      409,
      "This quote requires a sponsored or unsupported signing route. Request another quote or try a paper trade.",
    );
  if (error.code === "STALE_ORDER")
    return new TradeAttemptError("QUOTE_UNAVAILABLE", 409, "Request a fresh real order");
  if (error.code === "INVALID_ORDER" || error.code === "INVALID_REQUEST")
    return new TradeAttemptError("CONFLICT", 409, "Order or signed transaction does not match");
  return new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Order or execution service unavailable", error);
}

/** Authenticated wallet is the only source of owner/taker; provider I/O stays outside DB transactions. */
export function createTradeAttemptService(
  auth: AuthStore,
  jupiter?: TradeOrderProvider,
  now: () => number = Date.now,
  assessor?: TradeAssessor,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  async function owner<T>(tokenHash: string, run: (tx: DatabaseExecutor, session: Session) => Promise<T>) {
    const result = await auth.withSession(tokenHash, run);
    if (result === null) throw new TradeAttemptError("UNAUTHORIZED", 401, "Valid session required");
    return result;
  }
  async function signalFor(tx: DatabaseExecutor, id: string) {
    const signal = await createReadStore(tx, network).signal(id);
    if (!signal) throw new TradeAttemptError("NOT_FOUND", 404, "Signal not found");
    assertSupportedSignal(signal);
    return signal;
  }
  return {
    async order(tokenHash: string, input: CreateTradeAttemptRequest) {
      if (network !== "mainnet" && input.inputMint !== WRAPPED_SOL_MINT)
        throw new TradeAttemptError(
          "UNSUPPORTED_ROUTE",
          409,
          "USDC trading is available on Mainnet only. Use test SOL on Devnet.",
        );
      const initial = await owner(tokenHash, async (tx, session) => ({
        signal: await signalFor(tx, input.signalId),
        wallet: session.walletAddress,
        userId: session.userId,
      }));
      if (!assessor) throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Current trade checks are unavailable");
      if (!jupiter) throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Real orders are unavailable");
      const assessment = await assessor.assess(initial.signal, "real", input.inputAmountRaw, input.inputMint);
      if ((assessment.network ?? "mainnet") !== network)
        throw new TradeAssessmentError("CONFLICT", 409, "Trade checks belong to another network.");
      assertTradeAssessment(assessment, initial.signal, "real", input.inputAmountRaw, now(), input.inputMint);
      let order: RealOrder;
      try {
        order = realOrderSchema.parse(
          await jupiter.getRealOrder(
            {
              signalId: input.signalId,
              outputMint: initial.signal.mintAddress,
              inputMint: input.inputMint,
              inputAmountRaw: input.inputAmountRaw,
              taker: initial.wallet,
            },
            initial.wallet,
          ),
        );
      } catch (error) {
        if (error instanceof JupiterServiceError) throw mapJupiter(error);
        throw error;
      }
      if ((order.network ?? "mainnet") !== network)
        throw new TradeAttemptError("CONFLICT", 409, "Order belongs to another network.");
      assertTradeAssessment(assessment, initial.signal, "real", input.inputAmountRaw, now(), input.inputMint);
      order = realOrderSchema.parse({
        ...order,
        assessment,
      });
      const attempt = await owner(tokenHash, async (tx, session) => {
        const signal = await signalFor(tx, input.signalId);
        assertOrder(order, signal, session, input, now());
        const store = createTradeAttemptStore(tx, session.userId, network);
        if (await store.hasPending(order.outputMint))
          throw new TradeAttemptError(
            "CONFLICT",
            409,
            "Check your pending purchase of this token before buying again.",
          );
        const created = await store.create(order);
        if (!created) throw new TradeAttemptError("CONFLICT", 409, "Order request already recorded");
        return created;
      });
      return tradeAttemptOrderResponseSchema.parse({ attempt, order });
    },
    async get(tokenHash: string, id: string) {
      const initial = await owner(tokenHash, async (tx, session) => {
        const store = createTradeAttemptStore(tx, session.userId, network);
        const item = await store.get(id);
        if (!item) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt not found");
        const review = await store.review(id);
        if (item.status === "prepared" && (!review || now() >= Date.parse(review.expiresAt)))
          return { item: (await store.expire(id, true)) ?? item, review };
        return { item, review };
      });
      if (
        (initial.item.status !== "submitted" &&
          !(
            initial.item.status === "confirmed" &&
            initial.review !== null &&
            initial.item.receipt?.feeLamports == null
          )) ||
        !initial.item.signature ||
        !initial.item.outputMint ||
        !jupiter?.getExecution
      )
        return initial.item;
      const signature = initial.item.signature;
      try {
        const result = await jupiter.getExecution(
          signature,
          initial.item.requestId,
          initial.item.taker,
          initial.item.outputMint,
          initial.review ?? undefined,
        );
        if (
          !result ||
          result.requestId !== initial.item.requestId ||
          (result.signature !== null && result.signature !== signature) ||
          (initial.item.status === "confirmed" && result.status !== "confirmed")
        )
          return initial.item;
        return await owner(tokenHash, async (tx, session) => {
          const store = createTradeAttemptStore(tx, session.userId, network);
          return (
            (await store.complete(id, initial.item.quoteId, initial.item.requestId, signature, result)) ??
            (await store.get(id)) ??
            initial.item
          );
        });
      } catch (error) {
        if (error instanceof TradeAttemptError) throw error;
        await owner(tokenHash, async () => true);
        return initial.item;
      }
    },
    async list(tokenHash: string, query: GetTradeAttemptsQuery) {
      const page = await owner(tokenHash, async (tx, session) => {
        const found = await createTradeAttemptStore(tx, session.userId, network).list(query);
        if (!found) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt cursor not found");
        return found;
      });
      // Bound RPC work per page; the client also polls each unresolved attempt directly.
      let remaining = 4;
      for (let i = 0; i < page.items.length; i++) {
        const item = page.items[i];
        if (
          item &&
          remaining > 0 &&
          (item.status === "submitted" ||
            item.status === "prepared" ||
            (item.status === "confirmed" && !item.receipt?.feeLamports))
        ) {
          page.items[i] = await this.get(tokenHash, item.id);
          remaining--;
        }
      }
      return page;
    },
    async reject(tokenHash: string, id: string, input: RejectTradeAttemptRequest) {
      return owner(tokenHash, async (tx, session) => {
        const store = createTradeAttemptStore(tx, session.userId, network);
        const attempt = await store.get(id);
        if (!attempt) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt not found");
        const result = await store.reject(id, input.quoteId, input.requestId, input.reason);
        if (!result) throw new TradeAttemptError("CONFLICT", 409, "Attempt or order state does not match");
        return result;
      });
    },
    async execute(tokenHash: string, id: string, input: ExecuteTradeAttemptRequest) {
      const attempt = await owner(tokenHash, async (tx, session) => {
        const item = await createTradeAttemptStore(tx, session.userId, network).get(id);
        if (!item) throw new TradeAttemptError("NOT_FOUND", 404, "Trade attempt not found");
        if (
          item.status !== "prepared" ||
          item.quoteId !== input.quoteId ||
          item.requestId !== input.requestId ||
          item.taker !== session.walletAddress
        )
          throw new TradeAttemptError("CONFLICT", 409, "Attempt or order state does not match");
        const review = await createTradeAttemptStore(tx, session.userId, network).review(id);
        if (!review) throw new TradeAttemptError("QUOTE_UNAVAILABLE", 409, "Request a fresh real order");
        return { ...item, review };
      });
      if (!jupiter) throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Real execution is unavailable");
      if (!assessor) throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Current trade checks are unavailable");
      const signal = await owner(tokenHash, (tx) => signalFor(tx, attempt.signalId));
      const assessment = await assessor.assess(signal, "real", attempt.inputAmountRaw, attempt.inputMint);
      assertTradeAssessment(assessment, signal, "real", attempt.inputAmountRaw, now(), attempt.inputMint);
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
              assertTradeAssessment(assessment, signal, "real", attempt.inputAmountRaw, now(), attempt.inputMint);
              assertOrder(
                attempt.review,
                signal,
                session,
                {
                  signalId: attempt.signalId,
                  inputMint: attempt.inputMint,
                  inputAmountRaw: attempt.inputAmountRaw,
                },
                now(),
              );
              const updated = await createTradeAttemptStore(tx, session.userId, network).markSubmitted(
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
          attempt.review,
        );
        const confirmedSignature = signedSignature;
        if (!confirmedSignature || result.requestId !== attempt.requestId)
          throw new TradeAttemptError("SERVICE_UNAVAILABLE", 503, "Execution outcome requires reconciliation");
        const updated = await owner(tokenHash, async (tx, session) => {
          const row = await createTradeAttemptStore(tx, session.userId, network).complete(
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
              createTradeAttemptStore(tx, session.userId, network).markUnknown(id, attempt.quoteId, attempt.requestId),
            );
          } else if (error.code === "STALE_ORDER") {
            await owner(tokenHash, async (tx, session) =>
              createTradeAttemptStore(tx, session.userId, network).failPrepared(id, attempt.quoteId, attempt.requestId),
            );
          }
          throw mapJupiter(error);
        }
        throw error;
      }
    },
  };
}
