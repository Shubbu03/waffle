import {
  calculatePaperFill,
  PUMP_SWAP_PROGRAM_ID,
  paperPositionWithFillSchema,
  paperQuoteSchema,
  WRAPPED_SOL_MINT,
} from '@waffle/shared'
export const PAPER_TEST_SIGNAL = '44444444-4444-4444-8444-444444444444'
export function paperQuoteFixture(now = Date.now(), size = '100000000') {
  return paperQuoteSchema.parse({
    id: crypto.randomUUID(),
    signalId: PAPER_TEST_SIGNAL,
    kind: 'paper',
    providerQuoteId: null,
    inputMint: WRAPPED_SOL_MINT,
    outputMint: PUMP_SWAP_PROGRAM_ID,
    outputDecimals: 6,
    inputAmountLamports: size,
    outputAmountRaw: '9007199254740993123',
    minOutputAmountRaw: '8556839292003943467',
    requestId: 'test-only',
    router: 'metis',
    feeLamports: '8000',
    fees: {
      totalBps: 10,
      mint: PUMP_SWAP_PROGRAM_ID,
      platform: null,
      signatureLamports: '5000',
      prioritizationLamports: '1000',
      rentLamports: '2000',
    },
    slippageBps: 500,
    priceImpactBps: 50,
    priceImpactPct: -0.5,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10000).toISOString(),
  })
}
export function paperPositionFixture(quote = paperQuoteFixture(), now = Date.parse(quote.fetchedAt)) {
  return paperPositionWithFillSchema.parse({
    id: crypto.randomUUID(),
    signalId: quote.signalId,
    sizeLamports: quote.inputAmountLamports,
    entryQuote: quote,
    simulated: true,
    status: 'open',
    createdAt: new Date(now).toISOString(),
    closedAt: null,
    fill: calculatePaperFill(quote, now),
  })
}
