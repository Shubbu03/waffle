import type { PaperQuote } from "../contracts/quote.ts";
import { WRAPPED_SOL_MINT } from "../program-ids.ts";

/** Jupiter's output already includes route fees; network fees are a separate SOL debit. */
export function calculatePaperFill(quote: PaperQuote, filledAtMs: number) {
  return {
    outputAmountRaw: quote.outputAmountRaw,
    minOutputAmountRaw: quote.minOutputAmountRaw,
    totalDebitRaw: (
      BigInt(quote.inputAmountRaw) + (quote.inputMint === WRAPPED_SOL_MINT ? BigInt(quote.feeLamports) : 0n)
    ).toString(),
    networkFeeLamports: quote.feeLamports,
    quoteAgeMs: filledAtMs - Date.parse(quote.fetchedAt),
  };
}
