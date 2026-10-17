import { expect, test } from "bun:test";
import {
  calculatePaperFill,
  createTradeAttemptRequestSchema,
  DEVNET_USDC_MINT,
  formatPayment,
  paperQuoteSchema,
  parseAssetAmount,
  paymentSizeAllowed,
  USDC_MINT,
  WRAPPED_SOL_MINT,
} from "../src/index.ts";

test("USDC and SOL amounts preserve exact smallest units and reject excess precision", () => {
  expect(parseAssetAmount("1.000001", 6)).toBe("1000001");
  expect(parseAssetAmount("0.000000001", 9)).toBe("1");
  for (const value of ["1.0000001", "1e2", "-1", "0", "0.0", "NaN", "01", "18446744073709551616"])
    expect(parseAssetAmount(value, 6)).toBeNull();
  expect(formatPayment("1000001", USDC_MINT)).toBe("1.000001 USDC");
  expect(paymentSizeAllowed(USDC_MINT, "5000000", "real")).toBe(true);
  expect(paymentSizeAllowed(USDC_MINT, "5000001", "real")).toBe(false);
  expect(paymentSizeAllowed(WRAPPED_SOL_MINT, "50000000", "real")).toBe(true);
  expect(paymentSizeAllowed(WRAPPED_SOL_MINT, "50000001", "real")).toBe(false);
});

test("trade input only accepts configured Mainnet currencies, not lookalike or Devnet USDC", () => {
  const request = { signalId: crypto.randomUUID(), inputAmountRaw: "1000000", inputMint: USDC_MINT };
  expect(createTradeAttemptRequestSchema.safeParse(request).success).toBe(true);
  expect(createTradeAttemptRequestSchema.safeParse({ ...request, inputMint: DEVNET_USDC_MINT }).success).toBe(false);
  expect(createTradeAttemptRequestSchema.safeParse({ ...request, inputMint: "USDC" }).success).toBe(false);
});

test("paper USDC debit keeps SOL network fees separate", () => {
  const quote = paperQuoteSchema.parse({
    id: crypto.randomUUID(),
    signalId: crypto.randomUUID(),
    kind: "paper",
    inputMint: USDC_MINT,
    outputMint: WRAPPED_SOL_MINT,
    inputAmountRaw: "5000000",
    outputAmountRaw: "1000",
    minOutputAmountRaw: "990",
    requestId: "paper-usdc",
    router: "metis",
    providerQuoteId: null,
    feeLamports: "5000",
    fees: {
      totalBps: 0,
      mint: null,
      platform: null,
      signatureLamports: "5000",
      prioritizationLamports: "0",
      rentLamports: "0",
    },
    slippageBps: 100,
    priceImpactBps: 0,
    priceImpactPct: 0,
    fetchedAt: new Date(1000).toISOString(),
    expiresAt: new Date(5000).toISOString(),
  });
  expect(calculatePaperFill(quote, 2000)).toMatchObject({
    totalDebitRaw: "5000000",
    networkFeeLamports: "5000",
    quoteAgeMs: 1000,
  });
});
