import {
  type CreatePaperPositionRequest,
  type CreatePaperQuoteRequest,
  createPaperPositionRequestSchema,
  createPaperQuoteRequestSchema,
  idSchema,
  paperPositionLookupSchema,
  paperPositionsResponseSchema,
  paperPositionWithFillSchema,
  paperQuoteSchema,
  paperValuationSchema,
} from '@waffle/shared'
import { ApiError, apiRequest } from './api-client'

function responseData<T>(
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
  data: unknown,
): T {
  const parsed = schema.safeParse(data)
  if (!parsed.success)
    throw new ApiError(0, 'BAD_RESPONSE', 'The server returned an invalid paper trading response. Try refreshing.')
  return parsed.data
}

export async function preparePaperQuote(input: CreatePaperQuoteRequest, token: string, signal?: AbortSignal) {
  const request = createPaperQuoteRequestSchema.parse(input)
  const quote = responseData(
    paperQuoteSchema,
    await apiRequest('/paper-positions/quote', { method: 'POST', data: request, signal, timeoutMs: 30_000 }, token),
  )
  if (quote.signalId !== request.signalId || quote.inputAmountLamports !== request.sizeLamports)
    throw new ApiError(0, 'BAD_RESPONSE', 'Quote does not match this review.')
  return quote
}
export async function createPaperPosition(input: CreatePaperPositionRequest, token: string) {
  const request = createPaperPositionRequestSchema.parse(input)
  const position = responseData(
    paperPositionWithFillSchema,
    await apiRequest('/paper-positions', { method: 'POST', data: request }, token),
  )
  if (
    position.entryQuote.id !== request.quoteId ||
    position.signalId !== request.signalId ||
    position.sizeLamports !== request.sizeLamports
  )
    throw new ApiError(0, 'BAD_RESPONSE', 'Fill does not match this review.')
  return position
}
export async function lookupPaperPosition(quoteId: string, token: string) {
  idSchema.parse(quoteId)
  const { position } = responseData(
    paperPositionLookupSchema,
    await apiRequest(`/paper-positions/by-quote/${quoteId}`, {}, token),
  )
  if (position && position.entryQuote.id !== quoteId)
    throw new ApiError(0, 'BAD_RESPONSE', 'Fill does not match this quote.')
  return position
}
export async function listPaperPositions(token: string, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '20' })
  if (cursor) params.set('cursor', idSchema.parse(cursor))
  return responseData(paperPositionsResponseSchema, await apiRequest(`/paper-positions?${params}`, { signal }, token))
}
export async function getPaperPosition(id: string, token: string, signal?: AbortSignal) {
  idSchema.parse(id)
  const position = responseData(
    paperPositionWithFillSchema,
    await apiRequest(`/paper-positions/${id}`, { signal }, token),
  )
  if (position.id !== id) throw new ApiError(0, 'BAD_RESPONSE', 'Position does not match this request.')
  return position
}
export async function getPaperValuation(id: string, token: string, signal?: AbortSignal) {
  idSchema.parse(id)
  const value = responseData(
    paperValuationSchema,
    await apiRequest(`/paper-positions/${id}/valuation`, { signal }, token),
  )
  if (value.positionId !== id) throw new ApiError(0, 'BAD_RESPONSE', 'Value does not match this position.')
  return value
}
