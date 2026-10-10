import { apiRequest } from './api-client'
import { ApiError } from './api-error'

export type CatalogWallet = {
  id: string
  address: string
  label: string
  active: boolean
  source: 'catalog' | 'user'
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
    source: value.source === 'user' ? 'user' : 'catalog',
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
  const payload = (await apiRequest('/wallets', { method: 'GET', signal })) as { items?: unknown }
  if (!Array.isArray(payload?.items)) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed catalog response')
  return payload.items.map(parseWallet)
}

/** Owner's follows — bearer required. */
export async function listSubscriptions(token: string, signal?: AbortSignal): Promise<WalletSubscription[]> {
  const payload = (await apiRequest('/wallet-subscriptions', { method: 'GET', signal }, token)) as { items?: unknown }
  if (!Array.isArray(payload?.items)) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed subscriptions response')
  return payload.items.map(parseSubscription)
}

/** Idempotent follow (or alert update). 409 = paused wallet, surfaced as ApiError. */
export async function followWallet(
  token: string,
  walletId: string,
  alertsEnabled?: boolean,
): Promise<WalletSubscription> {
  const payload = await apiRequest(
    `/wallet-subscriptions/${walletId}`,
    { method: 'PUT', data: alertsEnabled === undefined ? {} : { alertsEnabled } },
    token,
  )
  return parseSubscription(payload)
}

/** Idempotent unfollow — 204 expected. */
export async function unfollowWallet(token: string, walletId: string): Promise<void> {
  await apiRequest(`/wallet-subscriptions/${walletId}`, { method: 'DELETE' }, token)
}

/** Paste-to-track a wallet address (bearer). Returns the tracked wallet + whether it was newly added. */
export async function trackWallet(
  token: string,
  address: string,
  label?: string,
): Promise<{ wallet: CatalogWallet; created: boolean; followed: boolean; veryActive: boolean }> {
  const payload = (await apiRequest(
    '/wallets',
    { method: 'POST', data: label ? { address, label } : { address } },
    token,
  )) as { wallet?: unknown; created?: unknown; followed?: unknown; warning?: unknown }
  if (!isRecord(payload) || payload.wallet === undefined) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed track response')
  }
  return {
    wallet: parseWallet(payload.wallet),
    created: payload.created === true,
    followed: payload.followed === true,
    veryActive: payload.warning === 'very-active',
  }
}

/** Stop tracking a wallet you added (bearer). `paused` = watcher subscription stopped. */
export async function untrackWallet(token: string, walletId: string): Promise<{ paused: boolean }> {
  const payload = (await apiRequest(`/wallets/${walletId}`, { method: 'DELETE' }, token)) as { paused?: unknown }
  return { paused: isRecord(payload) && payload.paused === true }
}

/** Wallet IDs the caller personally tracks (bearer). */
export async function listMyTrackedWallets(token: string, signal?: AbortSignal): Promise<string[]> {
  const payload = (await apiRequest('/wallets/mine', { method: 'GET', signal }, token)) as { items?: unknown }
  if (!Array.isArray(payload?.items)) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed tracked response')
  return payload.items.filter((item): item is string => typeof item === 'string')
}
