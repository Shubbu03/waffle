/** Wallet catalog + subscription API for issue #22. Logs paths, never tokens. */

import { apiFetch, readJson } from './api-client'
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
export async function listWallets(): Promise<CatalogWallet[]> {
  console.log('[wallets-api] listWallets: fetching catalog')
  const response = await apiFetch('/wallets', { method: 'GET' })
  const payload = (await readJson(response, '/wallets')) as { items?: unknown }
  if (!Array.isArray(payload?.items)) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed catalog response')
  const items = payload.items.map(parseWallet)
  console.log(`[wallets-api] listWallets: ${items.length} wallets`)
  return items
}

/** Owner's follows — bearer required. */
export async function listSubscriptions(token: string): Promise<WalletSubscription[]> {
  console.log('[wallets-api] listSubscriptions: fetching follows')
  const response = await apiFetch('/wallet-subscriptions', { method: 'GET' }, token)
  const payload = (await readJson(response, '/wallet-subscriptions')) as { items?: unknown }
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
  const response = await apiFetch(
    `/wallet-subscriptions/${walletId}`,
    { method: 'PUT', body: JSON.stringify(alertsEnabled === undefined ? {} : { alertsEnabled }) },
    token,
  )
  const payload = (await readJson(response, `/wallet-subscriptions/${walletId}`)) as unknown
  console.log('[wallets-api] followWallet: ok')
  return parseSubscription(payload)
}

/** Idempotent unfollow — 204 expected. */
export async function unfollowWallet(token: string, walletId: string): Promise<void> {
  console.log(`[wallets-api] unfollowWallet: ${walletId.slice(0, 8)}...`)
  const response = await apiFetch(`/wallet-subscriptions/${walletId}`, { method: 'DELETE' }, token)
  if (response.status !== 204) {
    await readJson(response, `/wallet-subscriptions/${walletId}`)
  }
  console.log('[wallets-api] unfollowWallet: ok')
}
