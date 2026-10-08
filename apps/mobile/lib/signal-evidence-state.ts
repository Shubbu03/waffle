import {
  type SignalDetail,
  SPL_TOKEN_PROGRAM_ID,
  scorePolicyV1,
  TOKEN_2022_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from '@waffle/shared'

export function tokenProgramLabel(programId: string | undefined): string {
  if (!programId) return 'Unknown'
  if (programId === SPL_TOKEN_PROGRAM_ID) return 'SPL Token'
  if (programId === TOKEN_2022_PROGRAM_ID) return 'Token-2022'
  return 'Unsupported'
}

export type EvidenceKey = keyof NonNullable<SignalDetail['snapshot']['assessment']>['evidence']
export type EvidenceLabel = 'Fresh' | 'Expired' | 'Unknown' | 'Unavailable'

/** A persisted passing check is historical; its evidence must still match and be fresh today. */
export function signalEvidenceLabel(
  signal: SignalDetail,
  key: EvidenceKey,
  offline: boolean,
  now: number,
): EvidenceLabel {
  const data = signal.snapshot[key]
  if (!data) return 'Unavailable'
  const state = signal.snapshot.assessment?.evidence[key]
  if (offline || !state || state.status === 'unknown') return 'Unknown'
  const { mint, pool, quote, oracle } = signal.snapshot
  if (
    (key === 'mint' && mint?.address !== signal.mintAddress) ||
    (key === 'pool' && (pool?.baseMint !== signal.mintAddress || pool?.quoteMint !== WRAPPED_SOL_MINT)) ||
    (key === 'quote' && (quote?.outputMint !== signal.mintAddress || quote?.inputMint !== WRAPPED_SOL_MINT)) ||
    (key === 'oracle' && oracle?.mintAddress !== signal.mintAddress)
  )
    return 'Unknown'
  const fetched = Date.parse(data.fetchedAt)
  const expires = state.expiresAt ? Date.parse(state.expiresAt) : NaN
  if (!Number.isFinite(fetched) || fetched > now) return 'Unknown'
  const maxAge = scorePolicyV1.freshness[`${key}Ms`]
  if (state.status === 'stale' || now - fetched > maxAge || (Number.isFinite(expires) && expires <= now))
    return 'Expired'
  return Number.isFinite(expires) ? 'Fresh' : 'Unknown'
}
