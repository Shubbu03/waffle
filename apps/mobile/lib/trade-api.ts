/** Real-trade API for issue #27. Logs paths, never keys or bytes. */

import { tradeAttemptOrderResponseSchema, tradeAttemptSchema } from '@waffle/shared'

export type { RealOrder, TradeAttempt } from '@waffle/shared'

import type { RealOrder, TradeAttempt } from '@waffle/shared'
import { apiRequest } from './api-client'
import { ApiError } from './api-error'

/** Ask the server for a guarded order (0.05 SOL cap enforced server-side too). */
export async function createTradeAttempt(
  token: string,
  signalId: string,
  inputAmountLamports: string,
): Promise<{ order: RealOrder; attempt: TradeAttempt }> {
  console.log(`[trade-api] createTradeAttempt: signal=${signalId.slice(0, 8)}... amount=${inputAmountLamports}`)
  const response = await apiRequest(
    '/trade-attempts',
    { method: 'POST', data: { signalId, inputAmountLamports }, timeoutMs: 30_000 },
    token,
  )
  const parsed = tradeAttemptOrderResponseSchema.safeParse(response)
  if (!parsed.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed trade-attempt response')
  const payload = parsed.data
  if (
    payload.order.signalId !== signalId ||
    payload.order.inputAmountLamports !== inputAmountLamports ||
    payload.attempt.signalId !== signalId ||
    payload.attempt.quoteId !== payload.order.id ||
    payload.attempt.requestId !== payload.order.requestId ||
    payload.attempt.taker !== payload.order.taker ||
    payload.attempt.inputAmountLamports !== inputAmountLamports
  )
    throw new ApiError(0, 'BAD_RESPONSE', 'Order does not match this trade review')
  console.log(
    `[trade-api] createTradeAttempt: attempt=${payload.attempt.id.slice(0, 8)}... router=${payload.order.router}`,
  )
  return payload
}

/** Submit the wallet-signed transaction for execution. Returns the traced attempt. */
export async function executeTradeAttempt(
  token: string,
  attemptId: string,
  body: { signedTransactionBase64: string; requestId: string; quoteId: string },
): Promise<TradeAttempt> {
  console.log(
    `[trade-api] executeTradeAttempt: ${attemptId.slice(0, 8)}... (${body.signedTransactionBase64.length}B signed)`,
  )
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
  const payload = parsed.data
  console.log(
    `[trade-api] executeTradeAttempt: status=${payload.status} code=${payload.executeCode} sig=${payload.signature?.slice(0, 8) ?? 'none'}...`,
  )
  return payload
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
  console.log(`[trade-api] rejectTradeAttempt: ${attemptId.slice(0, 8)}... (${body.reason})`)
  await apiRequest(`/trade-attempts/${attemptId}/wallet-rejection`, { method: 'POST', data: body }, token)
  console.log('[trade-api] rejectTradeAttempt: recorded')
}
