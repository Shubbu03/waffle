import { idSchema, type SignalPage, signalDetailSchema, signalPageSchema } from '@waffle/shared'
import { ApiError, apiRequest } from './api-client'
import type { SignalView } from './signal-state'

export type SignalQuery = { view: SignalView; walletId?: string; cursor?: string; direction?: 'before' | 'after' }
export async function listSignals(query: SignalQuery, token?: string, signal?: AbortSignal): Promise<SignalPage> {
  if (query.walletId && !idSchema.safeParse(query.walletId).success)
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid wallet ID')
  const params = new URLSearchParams({ view: query.view, direction: query.direction ?? 'before', limit: '50' })
  if (query.walletId) params.set('walletId', query.walletId)
  if (query.cursor) params.set('cursor', query.cursor)
  const response = await apiRequest(`/signals?${params}`, { signal }, query.view === 'following' ? token : undefined)
  const parsed = signalPageSchema.safeParse(response)
  if (
    !parsed.success ||
    parsed.data.view !== query.view ||
    parsed.data.direction !== (query.direction ?? 'before') ||
    (query.walletId && parsed.data.items.some((item) => item.walletId !== query.walletId))
  ) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed signal page')
  }
  return parsed.data
}
export async function getSignal(id: string, signal?: AbortSignal) {
  if (!idSchema.safeParse(id).success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid signal ID')
  const response = await apiRequest(`/signals/${id}`, { signal })
  const parsed = signalDetailSchema.safeParse(response)
  if (!parsed.success || parsed.data.id !== id) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed signal detail')
  return parsed.data
}
