import { type SignalDetail, type SignalSummary, scorePolicyV1 } from '@waffle/shared'

export type SignalView = 'all' | 'following'
export const MAX_CACHED_SIGNALS = 200
export function mergeSignals(existing: SignalSummary[], incoming: SignalSummary[]): SignalSummary[] {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) =>
    BigInt(a.eventId) > BigInt(b.eventId) ? -1 : BigInt(a.eventId) < BigInt(b.eventId) ? 1 : 0,
  )
}
export function ageLabel(timestamp: string | null, now = Date.now()): string {
  if (!timestamp) return 'Age unknown'
  const age = now - Date.parse(timestamp)
  if (!Number.isFinite(age) || age < 0) return 'Age unknown'
  const seconds = Math.floor(age / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
function fresh(timestamp: string | null | undefined, limit: number, now: number): boolean {
  if (!timestamp) return false
  const age = now - Date.parse(timestamp)
  return Number.isFinite(age) && age >= 0 && age <= limit
}
export function signalDataLabel(signal: SignalSummary, offline: boolean, now = Date.now()): string {
  if (offline) return 'Cached · stale'
  if (!fresh(signal.observedAt, scorePolicyV1.freshness.signalMs, now)) return 'Stale'
  if (signal.dataStatus === 'unknown') return 'Unknown data'
  if (signal.dataStatus === 'stale') return 'Stale'
  return signal.dataStatus === 'partial' ? 'Partial data' : 'Complete data'
}
export function copyBlockReason(signal: SignalDetail, offline: boolean, now = Date.now()): string | null {
  if (offline) return 'Reconnect and refresh before copying.'
  if (signal.status === 'suppressed') return 'Copying is blocked by the signal checks.'
  if (signal.status === 'history-only') return 'This signal is for history only.'
  if (signal.dataStatus === 'unknown' || signal.dataStatus === 'stale') return 'Critical data is unknown or stale.'
  const assessment = signal.snapshot.assessment
  if (!assessment || assessment.streamStale) return 'The source stream is degraded or its health is unknown.'
  if (
    !fresh(assessment.transactionAt, scorePolicyV1.freshness.signalMs, now) ||
    !fresh(signal.observedAt, scorePolicyV1.freshness.signalMs, now)
  )
    return 'This signal is stale.'
  for (const key of ['mint', 'pool'] as const) {
    const evidence = assessment.evidence[key]
    if (evidence.status !== 'fresh' || !evidence.expiresAt || Date.parse(evidence.expiresAt) <= now) {
      return 'Token or pool checks need refreshing.'
    }
  }
  if (
    !fresh(signal.snapshot.mint?.fetchedAt, scorePolicyV1.freshness.mintMs, now) ||
    !fresh(signal.snapshot.pool?.fetchedAt, scorePolicyV1.freshness.poolMs, now)
  ) {
    return 'Token or pool checks need refreshing.'
  }
  return null
}
