import { type AuthStore, createPaperPositionStore, createReadStore, type DatabaseExecutor } from "@waffle/db";
import {
  type ApiErrorCode,
  type CreatePaperPositionRequest,
  type CreatePaperQuoteRequest,
  checkTradeLimits,
  type GetPaperPositionsQuery,
  type PaperQuote,
  paperQuoteSchema,
  type Session,
  type SignalDetail,
  scorePolicyV1,
} from "@waffle/shared";
import { type JupiterService, JupiterServiceError } from "./jupiter.ts";

export class PaperPositionError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: 401 | 404 | 409 | 503,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

function assertSignalFresh(signal: SignalDetail, sizeLamports: string, now: number) {
  const { snapshot } = signal;
  const fresh = (timestamp: string | null | undefined, maxAge: number) => {
    const age = now - Date.parse(timestamp ?? "");
    return Number.isFinite(age) && age >= 0 && age <= maxAge;
  };
  if (
    signal.status !== "eligible" ||
    !snapshot.assessment ||
    snapshot.assessment.streamStale ||
    !fresh(snapshot.assessment.transactionAt, scorePolicyV1.freshness.signalMs) ||
    !fresh(signal.observedAt, scorePolicyV1.freshness.signalMs) ||
    !fresh(snapshot.mint?.fetchedAt, scorePolicyV1.freshness.mintMs) ||
    !snapshot.pool
  ) {
    throw new PaperPositionError("STALE_SIGNAL", 409, "Signal is not eligible for a paper fill");
  }
  const gate = checkTradeLimits(
    "paper",
    BigInt(sizeLamports),
    snapshot.pool.liquidityUsd,
    Date.parse(snapshot.pool.fetchedAt),
    now,
  );
  if (!gate.allowed)
    throw new PaperPositionError(
      gate.reason === "liquidity_stale" ? "STALE_SIGNAL" : "LIMIT_EXCEEDED",
      409,
      "Paper size or fresh liquidity requirement not met",
    );
}

function assertQuoteFresh(quote: PaperQuote, now: number) {
  const age = now - Date.parse(quote.fetchedAt);
  if (age < 0 || age >= scorePolicyV1.freshness.quoteMs || now >= Date.parse(quote.expiresAt)) {
    throw new PaperPositionError("QUOTE_UNAVAILABLE", 409, "Request a fresh paper quote");
  }
}

/** Owner-bound, single-use quotes are short-lived; durable fills live in Postgres. */
export function createPaperPositionService(
  auth: AuthStore,
  jupiter?: Pick<JupiterService, "getPaperQuote">,
  now: () => number = Date.now,
) {
  const quotes = new Map<string, { userId: string; quote: PaperQuote }>();
  async function owner<T>(tokenHash: string, run: (tx: DatabaseExecutor, session: Session) => Promise<T>) {
    const result = await auth.withSession(tokenHash, run);
    if (result === null) throw new PaperPositionError("UNAUTHORIZED", 401, "Valid session required");
    return result;
  }
  async function signalFor(tx: DatabaseExecutor, input: CreatePaperQuoteRequest) {
    const signal = await createReadStore(tx).signal(input.signalId);
    if (!signal) throw new PaperPositionError("NOT_FOUND", 404, "Signal not found");
    assertSignalFresh(signal, input.sizeLamports, now());
    return signal;
  }
  return {
    async quote(tokenHash: string, input: CreatePaperQuoteRequest) {
      const signal = await owner(tokenHash, (tx) => signalFor(tx, input));
      if (!jupiter) throw new PaperPositionError("SERVICE_UNAVAILABLE", 503, "Paper quotes are unavailable");
      let quote: PaperQuote;
      try {
        // Provider I/O runs outside the database transaction and never supplies a taker.
        quote = paperQuoteSchema.parse(
          await jupiter.getPaperQuote({
            signalId: signal.id,
            outputMint: signal.mintAddress,
            inputAmountLamports: input.sizeLamports,
          }),
        );
      } catch (error) {
        if (error instanceof JupiterServiceError)
          throw new PaperPositionError("QUOTE_UNAVAILABLE", 503, "Unable to obtain a fresh paper quote", error);
        throw error;
      }
      if (
        quote.signalId !== signal.id ||
        quote.outputMint !== signal.mintAddress ||
        quote.inputAmountLamports !== input.sizeLamports
      ) {
        throw new PaperPositionError("QUOTE_UNAVAILABLE", 503, "Quote does not match the requested signal and size");
      }
      const userId = await owner(tokenHash, async (tx, session) => {
        await signalFor(tx, input);
        assertQuoteFresh(quote, now());
        return session.userId;
      });
      for (const [id, entry] of quotes) if (now() >= Date.parse(entry.quote.expiresAt)) quotes.delete(id);
      if (quotes.size >= 256) {
        const oldest = quotes.keys().next().value;
        if (oldest) quotes.delete(oldest);
      }
      quotes.set(quote.id, { userId, quote });
      return quote;
    },
    async create(tokenHash: string, input: CreatePaperPositionRequest) {
      let reserved: { userId: string; quote: PaperQuote } | undefined;
      try {
        return await owner(tokenHash, async (tx, session) => {
          const entry = quotes.get(input.quoteId);
          if (!entry || entry.userId !== session.userId) {
            throw new PaperPositionError("QUOTE_UNAVAILABLE", 409, "Request a fresh paper quote");
          }
          const quote = entry.quote;
          if (quote.signalId !== input.signalId || quote.inputAmountLamports !== input.sizeLamports) {
            throw new PaperPositionError("CONFLICT", 409, "Quote does not match the requested signal and size");
          }
          // Reserve before any await so overlapping requests cannot spend the same quote twice.
          quotes.delete(input.quoteId);
          reserved = entry;
          const signal = await signalFor(tx, input);
          if (quote.outputMint !== signal.mintAddress)
            throw new PaperPositionError("CONFLICT", 409, "Quote mint mismatch");
          const filledAt = now();
          assertSignalFresh(signal, input.sizeLamports, filledAt);
          assertQuoteFresh(quote, filledAt);
          return createPaperPositionStore(tx, session.userId).create(quote, filledAt);
        });
      } catch (error) {
        // Restore only after the owner transaction has rolled back.
        if (reserved && now() < Date.parse(reserved.quote.expiresAt)) quotes.set(input.quoteId, reserved);
        throw error;
      }
    },
    async list(tokenHash: string, input: GetPaperPositionsQuery) {
      return owner(tokenHash, async (tx, session) => {
        const page = await createPaperPositionStore(tx, session.userId).list(input);
        if (!page) throw new PaperPositionError("NOT_FOUND", 404, "Position cursor not found");
        return page;
      });
    },
  };
}
