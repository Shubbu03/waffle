import type { SignalSummary } from '@waffle/shared'
import type { SignalView } from './signal-state'
import type { CatalogWallet } from './wallets-api'

export type SignalWallet = {
  id: string
  address: string
  label: string
  active: boolean | null
  latestActivityAt: string | null
}

/** Use the complete catalog, not just the busiest wallets in the first signal page. */
export function signalWallets(
  catalog: CatalogWallet[],
  signals: SignalSummary[],
  view: SignalView,
  subscribedWalletIds: string[] | null,
): SignalWallet[] {
  const followed = subscribedWalletIds === null ? null : new Set(subscribedWalletIds)
  const wallets = new Map<string, SignalWallet>()
  for (const wallet of catalog) {
    if (view === 'following' && !followed?.has(wallet.id)) continue
    wallets.set(wallet.id, {
      id: wallet.id,
      address: wallet.address,
      label: wallet.label,
      active: wallet.active,
      latestActivityAt: wallet.recentSupportedActivityAt,
    })
  }
  for (const signal of signals) {
    if (view === 'following' && followed && !followed.has(signal.walletId)) continue
    const wallet = wallets.get(signal.walletId)
    if (wallet) {
      if (Date.parse(signal.observedAt) > (Date.parse(wallet.latestActivityAt ?? '') || 0))
        wallet.latestActivityAt = signal.observedAt
    } else {
      const known = catalog.find((entry) => entry.id === signal.walletId)
      wallets.set(signal.walletId, {
        id: signal.walletId,
        address: signal.walletAddress,
        label: known?.label ?? '',
        active: known?.active ?? null,
        latestActivityAt: signal.observedAt,
      })
    }
  }
  return [...wallets.values()].sort(
    (a, b) =>
      (Date.parse(b.latestActivityAt ?? '') || 0) - (Date.parse(a.latestActivityAt ?? '') || 0) ||
      (a.label || a.address).localeCompare(b.label || b.address) ||
      a.id.localeCompare(b.id),
  )
}
