/** Real-trade API for issue #27. Logs paths, never keys or bytes. */

import { apiRequest } from './api-client'
import { ApiError } from './api-error'

export type TradeAttempt = {
  id: string
  signalId: string
  quoteId: string
  requestId: string
  taker: string
  router: string
  inputAmountLamports: string
  status: 'prepared' | 'wallet_rejected' | 'submitted' | 'confirmed' | 'failed'
  signature: string | null
  executeCode: number | null
}

export type RealOrder = {
  id: string
  requestId: string
  router: string
  taker: string
  signatureFeePayer: string
  requiredSignatures: number
  gasless: boolean
  inputAmountLamports: string
  expiresAt: string
  transactionBase64: string
  [key: string]: unknown
}

/** Ask the server for a guarded order (0.05 SOL cap enforced server-side too). */
export async function createTradeAttempt(
  token: string,
  signalId: string,
  inputAmountLamports: string,
): Promise<{ order: RealOrder; attempt: TradeAttempt }> {
  console.log(`[trade-api] createTradeAttempt: signal=${signalId.slice(0, 8)}... amount=${inputAmountLamports}`)
  const payload = (await apiRequest(
    '/trade-attempts',
    { method: 'POST', data: { signalId, inputAmountLamports } },
    token,
  )) as { order: RealOrder; attempt: TradeAttempt }
  if (typeof payload?.order !== 'object' || typeof payload?.attempt !== 'object' || payload.order === null) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed trade-attempt response')
  }
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
  const payload = (await apiRequest(
    `/trade-attempts/${attemptId}/execute`,
    { method: 'POST', data: body },
    token,
  )) as TradeAttempt
  console.log(
    `[trade-api] executeTradeAttempt: status=${payload.status} code=${payload.executeCode} sig=${payload.signature?.slice(0, 8) ?? 'none'}...`,
  )
  return payload
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
