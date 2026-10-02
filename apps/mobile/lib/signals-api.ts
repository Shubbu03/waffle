import { idSchema, type SignalPage, signalDetailSchema, signalPageSchema } from '@waffle/shared'
import { ApiError, apiFetch, readJson } from './api-client'
import type { SignalView } from './signal-state'

export type SignalQuery = { view: SignalView; cursor?: string; direction?: 'before' | 'after' }
export async function listSignals(query: SignalQuery, token?: string, signal?: AbortSignal): Promise<SignalPage> {
  const params = new URLSearchParams({ view: query.view, direction: query.direction ?? 'before', limit: '50' })
  if (query.cursor) params.set('cursor', query.cursor)
  const response = await apiFetch(`/signals?${params}`, { signal }, query.view === 'following' ? token : undefined)
  const parsed = signalPageSchema.safeParse(await readJson(response, '/signals'))
  if (!parsed.success || parsed.data.view !== query.view || parsed.data.direction !== (query.direction ?? 'before')) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed signal page')
  }
  return parsed.data
}
export async function getSignal(id: string, signal?: AbortSignal) {
  if (!idSchema.safeParse(id).success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid signal ID')
  const response = await apiFetch(`/signals/${id}`, { signal })
  const parsed = signalDetailSchema.safeParse(await readJson(response, '/signals/:id'))
  if (!parsed.success || parsed.data.id !== id) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed signal detail')
  return parsed.data
}
