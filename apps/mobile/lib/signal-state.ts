import { PUMP_SWAP_PROGRAM_ID, type SignalDetail, type SignalSummary, scorePolicyV1 } from '@waffle/shared'

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
  if (signal.status === 'history-only') return 'Earlier buy'
  if (!fresh(signal.observedAt, scorePolicyV1.freshness.signalMs, now)) return 'Earlier buy'
  if (signal.dataStatus === 'unknown') return 'Unknown data'
  if (signal.dataStatus === 'stale') return 'Earlier buy'
  return signal.dataStatus === 'partial' ? 'Partial data' : 'Complete data'
}
/** Opening review requests fresh server checks; the historical score cannot authorize a trade. */
export function copyBlockReason(signal: SignalDetail, offline: boolean, _now = Date.now()): string | null {
  if (offline) return 'Reconnect and refresh before trading.'
  if (
    signal.sourceProgramId !== PUMP_SWAP_PROGRAM_ID ||
    !signal.reasons.some((reason) => reason.code === 'supported_buy' && reason.points === 20)
  )
    return 'This is not a confirmed supported buy.'
  return null
}
