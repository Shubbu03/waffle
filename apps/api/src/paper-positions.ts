import { type AuthStore, createPaperPositionStore, createReadStore, type DatabaseExecutor } from "@waffle/db";
import {
  type ApiErrorCode,
  type CreatePaperPositionRequest,
  type CreatePaperQuoteRequest,
  type GetPaperPositionsQuery,
  type PaperQuote,
  type PaperValuation,
  paperQuoteSchema,
  paperValuationQuoteSchema,
  type Session,
  scorePolicyV1,
} from "@waffle/shared";
import { type JupiterService, JupiterServiceError } from "./jupiter.ts";
import {
  assertSupportedSignal,
  assertTradeAssessment,
  TradeAssessmentError,
  type TradeAssessor,
} from "./trade-assessment.ts";

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

function assertQuoteFresh(quote: PaperQuote, now: number) {
  const age = now - Date.parse(quote.fetchedAt);
  if (
    age < 0 ||
    age >= (quote.network === "devnet" ? 60_000 : scorePolicyV1.freshness.quoteMs) ||
    now >= Date.parse(quote.expiresAt)
  ) {
    throw new PaperPositionError("QUOTE_UNAVAILABLE", 409, "Request a fresh paper quote");
  }
}

/** Owner-bound, single-use quotes are short-lived; durable fills live in Postgres. */
export function createPaperPositionService(
  auth: AuthStore,
  jupiter?: Pick<JupiterService, "getPaperQuote"> & Partial<Pick<JupiterService, "getPaperValuation">>,
  now: () => number = Date.now,
  assessor?: TradeAssessor,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  const quotes = new Map<string, { userId: string; quote: PaperQuote }>();
  async function owner<T>(tokenHash: string, run: (tx: DatabaseExecutor, session: Session) => Promise<T>) {
    const result = await auth.withSession(tokenHash, run);
    if (result === null) throw new PaperPositionError("UNAUTHORIZED", 401, "Valid session required");
    return result;
  }
  async function signalFor(tx: DatabaseExecutor, input: CreatePaperQuoteRequest) {
    const signal = await createReadStore(tx, network).signal(input.signalId);
    if (!signal) throw new PaperPositionError("NOT_FOUND", 404, "Signal not found");
    assertSupportedSignal(signal);
    return signal;
  }
  return {
    async quote(tokenHash: string, input: CreatePaperQuoteRequest) {
      const signal = await owner(tokenHash, (tx) => signalFor(tx, input));
      if (!assessor) throw new PaperPositionError("SERVICE_UNAVAILABLE", 503, "Current trade checks are unavailable");
      if (!jupiter) throw new PaperPositionError("SERVICE_UNAVAILABLE", 503, "Paper quotes are unavailable");
      const assessment = await assessor.assess(signal, "paper", input.sizeLamports);
      if ((assessment.network ?? "mainnet") !== network)
        throw new TradeAssessmentError("CONFLICT", 409, "Trade checks belong to another network.");
      assertTradeAssessment(assessment, signal, "paper", input.sizeLamports, now());
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
        (quote.network ?? "mainnet") !== network ||
        quote.signalId !== signal.id ||
        quote.outputMint !== signal.mintAddress ||
        quote.inputAmountLamports !== input.sizeLamports
      ) {
        throw new PaperPositionError("QUOTE_UNAVAILABLE", 503, "Quote does not match the requested signal and size");
      }
      assertTradeAssessment(assessment, signal, "paper", input.sizeLamports, now());
      quote = paperQuoteSchema.parse({
        ...quote,
        assessment,
        outputDecimals: assessment.mint.decimals,
        expiresAt: new Date(Math.min(Date.parse(quote.expiresAt), Date.parse(assessment.expiresAt))).toISOString(),
      });
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
          if (!quote.assessment) throw new PaperPositionError("QUOTE_UNAVAILABLE", 409, "Request a fresh paper quote");
          assertTradeAssessment(quote.assessment, signal, "paper", input.sizeLamports, filledAt);
          assertQuoteFresh(quote, filledAt);
          return createPaperPositionStore(tx, session.userId, network).create(quote, filledAt);
        });
      } catch (error) {
        // Restore only after the owner transaction has rolled back.
        if (reserved && now() < Date.parse(reserved.quote.expiresAt)) quotes.set(input.quoteId, reserved);
        throw error;
      }
    },
    async get(tokenHash: string, id: string) {
      return owner(tokenHash, async (tx, session) => {
        const position = await createPaperPositionStore(tx, session.userId, network).get(id);
        if (!position) throw new PaperPositionError("NOT_FOUND", 404, "Position not found");
        return position;
      });
    },
    async byQuote(tokenHash: string, quoteId: string) {
      return owner(tokenHash, async (tx, session) => ({
        position: await createPaperPositionStore(tx, session.userId, network).byQuote(quoteId),
      }));
    },
    async valuation(tokenHash: string, id: string): Promise<PaperValuation> {
      const position = await owner(tokenHash, async (tx, session) => {
        const found = await createPaperPositionStore(tx, session.userId, network).get(id);
        if (!found) throw new PaperPositionError("NOT_FOUND", 404, "Position not found");
        return found;
      });
      let result: PaperValuation = {
        status: "unavailable",
        positionId: id,
        reason: "No fresh exit quote is available. Try again later.",
      };
      if (position.status === "open" && jupiter?.getPaperValuation) {
        try {
          if (network === "devnet") {
            const signal = await owner(tokenHash, (tx) => createReadStore(tx, network).signal(position.signalId));
            if (!signal || !assessor) throw new JupiterServiceError("UPSTREAM_UNAVAILABLE");
            await assessor.assess(signal, "paper", position.sizeLamports);
          }
          const quote = paperValuationQuoteSchema.parse(
            await jupiter.getPaperValuation({
              positionId: id,
              ...(network === "devnet" ? { signalId: position.signalId } : {}),
              inputMint: position.entryQuote.outputMint,
              inputAmountRaw: position.fill.outputAmountRaw,
            }),
          );
          const age = now() - Date.parse(quote.fetchedAt);
          if (
            quote.inputMint === position.entryQuote.outputMint &&
            quote.inputAmountRaw === position.fill.outputAmountRaw &&
            age >= 0 &&
            age < scorePolicyV1.freshness.quoteMs &&
            now() < Date.parse(quote.expiresAt)
          ) {
            result = { status: "available", positionId: id, quote };
          }
        } catch (error) {
          if (!(error instanceof JupiterServiceError) && !(error instanceof Error && error.name === "ZodError"))
            throw error;
        }
      }
      // Revalidate the session after provider I/O, including logout while a request was pending.
      await owner(tokenHash, async () => true);
      return result;
    },
    async list(tokenHash: string, input: GetPaperPositionsQuery) {
      return owner(tokenHash, async (tx, session) => {
        const page = await createPaperPositionStore(tx, session.userId, network).list(input);
        if (!page) throw new PaperPositionError("NOT_FOUND", 404, "Position cursor not found");
        return page;
      });
    },
  };
}
