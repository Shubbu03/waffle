/** Wallet catalog + subscription API for issue #22. Logs paths, never tokens. */

import { apiRequest } from './api-client'
import { ApiError } from './api-error'

export type CatalogWallet = {
  id: string
  address: string
  label: string
  active: boolean
  inclusionReason: string
  recentSupportedActivityAt: string | null
}

export type WalletSubscription = {
  walletId: string
  alertsEnabled: boolean
  alertsEnabledAt: string | null
  createdAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function parseWallet(value: unknown): CatalogWallet {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.address !== 'string') {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed wallet entry')
  }
  return {
    id: value.id,
    address: value.address,
    label: typeof value.label === 'string' ? value.label : '',
    active: value.active === true,
    inclusionReason: typeof value.inclusionReason === 'string' ? value.inclusionReason : '',
    recentSupportedActivityAt:
      typeof value.recentSupportedActivityAt === 'string' ? value.recentSupportedActivityAt : null,
  }
}

function parseSubscription(value: unknown): WalletSubscription {
  if (!isRecord(value) || typeof value.walletId !== 'string') {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed subscription entry')
  }
  return {
    walletId: value.walletId,
    alertsEnabled: value.alertsEnabled === true,
    alertsEnabledAt: typeof value.alertsEnabledAt === 'string' ? value.alertsEnabledAt : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  }
}

/** Public catalog — no session needed. */
export async function listWallets(signal?: AbortSignal): Promise<CatalogWallet[]> {
  console.log('[wallets-api] listWallets: fetching catalog')
  const payload = (await apiRequest('/wallets', { method: 'GET', signal })) as { items?: unknown }
  if (!Array.isArray(payload?.items)) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed catalog response')
  const items = payload.items.map(parseWallet)
  console.log(`[wallets-api] listWallets: ${items.length} wallets`)
  return items
}

/** Owner's follows — bearer required. */
export async function listSubscriptions(token: string, signal?: AbortSignal): Promise<WalletSubscription[]> {
  console.log('[wallets-api] listSubscriptions: fetching follows')
  const payload = (await apiRequest('/wallet-subscriptions', { method: 'GET', signal }, token)) as { items?: unknown }
  if (!Array.isArray(payload?.items)) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed subscriptions response')
  const items = payload.items.map(parseSubscription)
  console.log(`[wallets-api] listSubscriptions: ${items.length} follows`)
  return items
}

/** Idempotent follow (or alert update). 409 = paused wallet, surfaced as ApiError. */
export async function followWallet(
  token: string,
  walletId: string,
  alertsEnabled?: boolean,
): Promise<WalletSubscription> {
  console.log(`[wallets-api] followWallet: ${walletId.slice(0, 8)}... alerts=${alertsEnabled ?? '(unchanged)'}`)
  const payload = await apiRequest(
    `/wallet-subscriptions/${walletId}`,
    { method: 'PUT', data: alertsEnabled === undefined ? {} : { alertsEnabled } },
    token,
  )
  console.log('[wallets-api] followWallet: ok')
  return parseSubscription(payload)
}

/** Idempotent unfollow — 204 expected. */
export async function unfollowWallet(token: string, walletId: string): Promise<void> {
  console.log(`[wallets-api] unfollowWallet: ${walletId.slice(0, 8)}...`)
  await apiRequest(`/wallet-subscriptions/${walletId}`, { method: 'DELETE' }, token)
  console.log('[wallets-api] unfollowWallet: ok')
}
