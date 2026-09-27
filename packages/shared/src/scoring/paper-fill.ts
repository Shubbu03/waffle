import type { PaperQuote } from "../contracts/quote.ts";

/** Jupiter's output already includes route fees; network fees are a separate SOL debit. */
export function calculatePaperFill(quote: PaperQuote, filledAtMs: number) {
  return {
    outputAmountRaw: quote.outputAmountRaw,
    minOutputAmountRaw: quote.minOutputAmountRaw,
    totalDebitLamports: (BigInt(quote.inputAmountLamports) + BigInt(quote.feeLamports)).toString(),
    quoteAgeMs: filledAtMs - Date.parse(quote.fetchedAt),
  };
}
