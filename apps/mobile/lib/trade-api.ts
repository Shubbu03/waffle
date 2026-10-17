import {
  idSchema,
  type PaymentMint,
  tradeAttemptOrderResponseSchema,
  tradeAttemptSchema,
  tradeAttemptsResponseSchema,
  WRAPPED_SOL_MINT,
} from '@waffle/shared'

export type { RealOrder, TradeAttempt } from '@waffle/shared'

import type { RealOrder, TradeAttempt } from '@waffle/shared'
import { apiRequest } from './api-client'
import { ApiError } from './api-error'

/** Ask the server for a guarded order (0.05 SOL cap enforced server-side too). */
export async function createTradeAttempt(
  token: string,
  signalId: string,
  inputAmountRaw: string,
  inputMint: PaymentMint = WRAPPED_SOL_MINT,
): Promise<{ order: RealOrder; attempt: TradeAttempt }> {
  const response = await apiRequest(
    '/trade-attempts',
    { method: 'POST', data: { signalId, inputAmountRaw, inputMint }, timeoutMs: 30_000 },
    token,
  )
  const parsed = tradeAttemptOrderResponseSchema.safeParse(response)
  if (!parsed.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed trade-attempt response')
  const payload = parsed.data
  if (
    payload.order.signalId !== signalId ||
    payload.order.inputMint !== inputMint ||
    payload.order.inputAmountRaw !== inputAmountRaw ||
    payload.attempt.signalId !== signalId ||
    payload.attempt.quoteId !== payload.order.id ||
    payload.attempt.requestId !== payload.order.requestId ||
    payload.attempt.taker !== payload.order.taker ||
    payload.attempt.inputAmountRaw !== inputAmountRaw
  )
    throw new ApiError(0, 'BAD_RESPONSE', 'Order does not match this trade review')
  return payload
}

/** Submit the wallet-signed transaction for execution. Returns the traced attempt. */
export async function executeTradeAttempt(
  token: string,
  attemptId: string,
  body: { signedTransactionBase64: string; requestId: string; quoteId: string },
): Promise<TradeAttempt> {
  // Jupiter can spend 20 seconds landing an order; don't time out before the server.
  const response = await apiRequest(
    `/trade-attempts/${attemptId}/execute`,
    { method: 'POST', data: body, timeoutMs: 30_000 },
    token,
  )
  const parsed = tradeAttemptSchema.safeParse(response)
  if (
    !parsed.success ||
    parsed.data.id !== attemptId ||
    parsed.data.quoteId !== body.quoteId ||
    parsed.data.requestId !== body.requestId
  )
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed execution response')
  return parsed.data
}

/** Read the saved outcome after a lost execution response. Never replays execution. */
export async function getTradeAttempt(token: string, attemptId: string): Promise<TradeAttempt> {
  const response = await apiRequest(`/trade-attempts/${attemptId}`, {}, token)
  const parsed = tradeAttemptSchema.safeParse(response)
  if (!parsed.success || parsed.data.id !== attemptId)
    throw new ApiError(0, 'BAD_RESPONSE', 'Trade status does not match this attempt')
  return parsed.data
}

/** Record a wallet-side rejection (user declined in wallet). */
export async function rejectTradeAttempt(
  token: string,
  attemptId: string,
  body: { quoteId: string; requestId: string; reason: 'WALLET_REJECTED' | 'USER_CANCELLED' },
): Promise<void> {
  await apiRequest(`/trade-attempts/${attemptId}/wallet-rejection`, { method: 'POST', data: body }, token)
}

export async function listTradeAttempts(token: string, cursor?: string, signal?: AbortSignal, signalId?: string) {
  const params = new URLSearchParams({ limit: '20' })
  if (cursor) params.set('cursor', idSchema.parse(cursor))
  if (signalId) params.set('signalId', idSchema.parse(signalId))
  const result = tradeAttemptsResponseSchema.safeParse(
    await apiRequest(`/trade-attempts?${params}`, { signal, timeoutMs: 30_000 }, token),
  )
  if (!result.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed trade history')
  if (signalId && result.data.items.some((item) => item.signalId !== signalId))
    throw new ApiError(0, 'BAD_RESPONSE', 'Trade history does not match this signal')
  return result.data
}
