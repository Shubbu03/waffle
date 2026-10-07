import {
  eventCursorSchema,
  type SignalDetail,
  type SignalSummary,
  signalDetailSchema,
  signalSummarySchema,
} from '@waffle/shared'

export type FeedCache = {
  version: 1
  items: SignalSummary[]
  appliedCursor: string | null
  nextCursor: string | null
  hasMore: boolean
  fetchedAt: number
  subscriptionKey: string | null
}
export function parseFeedCache(raw: string | null): FeedCache | null {
  if (!raw || raw.length > 1_000_000) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return null
    const record = value as Record<string, unknown>
    const items = signalSummarySchema.array().max(200).safeParse(record.items)
    const cursor = eventCursorSchema.nullable().safeParse(record.appliedCursor)
    const next = eventCursorSchema.nullable().safeParse(record.nextCursor)
    if (
      !items.success ||
      !cursor.success ||
      !next.success ||
      typeof record.hasMore !== 'boolean' ||
      typeof record.fetchedAt !== 'number' ||
      !Number.isFinite(record.fetchedAt) ||
      record.fetchedAt < 0 ||
      !(record.subscriptionKey === null || typeof record.subscriptionKey === 'string')
    )
      return null
    return {
      version: 1,
      items: items.data,
      appliedCursor: cursor.data,
      nextCursor: next.data,
      hasMore: record.hasMore,
      fetchedAt: record.fetchedAt,
      subscriptionKey: record.subscriptionKey,
    }
  } catch {
    return null
  }
}
export type CachedDetail = { signal: SignalDetail; fetchedAt: number }
export function parseCachedDetail(raw: string | null): CachedDetail | null {
  if (!raw || raw.length > 100_000) return null
  try {
    const record = JSON.parse(raw)
    const signal = signalDetailSchema.safeParse(record.signal)
    if (
      !signal.success ||
      typeof record.fetchedAt !== 'number' ||
      !Number.isFinite(record.fetchedAt) ||
      record.fetchedAt < 0
    )
      return null
    return { signal: signal.data, fetchedAt: record.fetchedAt }
  } catch {
    return null
  }
}
export function feedCacheKey(api: string, view: 'all' | 'following', owner: string | null, walletId?: string): string {
  if (view === 'following' && !owner) throw new Error('Following cache requires an owner.')
  return `waffle.signals.v1:${encodeURIComponent(api)}:${view}:${view === 'all' ? 'public' : owner}${walletId ? `:wallet:${encodeURIComponent(walletId)}` : ''}`
}
