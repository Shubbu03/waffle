import {
  PUMP_SWAP_PROGRAM_ID,
  type SignalSummary,
  SPL_TOKEN_PROGRAM_ID,
  signalDetailSchema,
  WRAPPED_SOL_MINT,
} from '@waffle/shared'
export function signalFixture(eventId = '9007199254740993', now = Date.now(), id: string = crypto.randomUUID()) {
  const iso = new Date(now).toISOString()
  const fresh = { status: 'fresh', expiresAt: new Date(now + 15_000).toISOString(), reason: null }
  const unknown = { status: 'unknown', expiresAt: null, reason: 'unavailable' }
  return signalDetailSchema.parse({
    id,
    eventId,
    signature: '1'.repeat(64),
    walletId: '11111111-1111-4111-8111-111111111111',
    walletAddress: WRAPPED_SOL_MINT,
    mintAddress: PUMP_SWAP_PROGRAM_ID,
    sourceProgramId: PUMP_SWAP_PROGRAM_ID,
    slot: 100,
    observedAt: iso,
    publishedAt: iso,
    scoreVersion: 1,
    score: 80,
    status: 'eligible',
    dataStatus: 'partial',
    reasons: [
      { code: 'supported_buy', points: 20 },
      { code: 'fresh_signal', points: 15 },
      { code: 'mint_safe', points: 20 },
      { code: 'pool_liquid', points: 15 },
      { code: 'quote_available', points: 10 },
      { code: 'holders_missing_stale_or_concentrated', points: 0 },
      { code: 'creator_missing_stale_or_concentrated', points: 0 },
      { code: 'oracle_none_or_stale', points: 0 },
    ],
    snapshot: {
      transactionSlot: 100,
      currentSlot: 100,
      mint: {
        address: PUMP_SWAP_PROGRAM_ID,
        tokenProgramId: SPL_TOKEN_PROGRAM_ID,
        mintAuthority: null,
        freezeAuthority: null,
        fetchedAt: iso,
      },
      pool: { baseMint: PUMP_SWAP_PROGRAM_ID, quoteMint: WRAPPED_SOL_MINT, liquidityUsd: 100_000, fetchedAt: iso },
      quote: {
        inputMint: WRAPPED_SOL_MINT,
        outputMint: PUMP_SWAP_PROGRAM_ID,
        inputLamports: '50000000',
        outputAmountRaw: '1000',
        fetchedAt: iso,
      },
      holders: null,
      creator: null,
      oracle: null,
      assessment: {
        scoredAt: iso,
        transactionAt: iso,
        source: 'provisional',
        streamStale: false,
        evidence: { mint: fresh, pool: fresh, quote: fresh, holders: unknown, creator: unknown, oracle: unknown },
      },
    },
  })
}
export function summaryFixture(eventId?: string, now?: number, id?: string): SignalSummary {
  const { reasons: _reasons, snapshot: _snapshot, ...summary } = signalFixture(eventId, now, id)
  return summary
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}
