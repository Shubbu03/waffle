/** Pure catalog/subscription merge for issue #22 (no RN imports — bun-testable).
 *
 * Rules (from docs/wallet-selection.md):
 * - New follows default to alerts OFF; omission preserves the existing preference.
 * - Paused wallets reject new follows/alerts; existing follows can be removed or muted.
 * - Unfollow never deletes shared history (client just drops the row).
 */
import type { CatalogWallet, WalletSubscription } from './wallets-api'

export type WalletRow = CatalogWallet & {
  followed: boolean
  alertsEnabled: boolean
  alertsEnabledAt: string | null
  followDisabled: boolean
  /** True when this user personally added the wallet to tracking (shows Untrack). */
  trackedByMe: boolean
}

/** Join catalog with the owner's follows, retaining controls for removing paused follows. */
export function mergeCatalog(
  wallets: CatalogWallet[],
  subscriptions: WalletSubscription[],
  trackedIds: string[] = [],
): WalletRow[] {
  console.log(`[wallets-state] mergeCatalog: ${wallets.length} wallets, ${subscriptions.length} follows`)
  const byId = new Map(subscriptions.map((s) => [s.walletId, s]))
  const tracked = new Set(trackedIds)
  return wallets.map((wallet) => {
    const sub = byId.get(wallet.id)
    return {
      ...wallet,
      followed: sub !== undefined,
      alertsEnabled: sub?.alertsEnabled ?? false,
      alertsEnabledAt: sub?.alertsEnabledAt ?? null,
      followDisabled: !wallet.active && !sub,
      trackedByMe: tracked.has(wallet.id),
    }
  })
}

/** A paused wallet may be muted but never newly enabled. */
export function nextAlertsValue(row: WalletRow): boolean | null {
  if (!row.followed || (!row.active && !row.alertsEnabled)) return null
  return !row.alertsEnabled
}

/** Whether the follow button should offer "Follow" (vs "Following"). */
export function followLabel(row: WalletRow): 'Follow' | 'Following' | 'Paused' {
  if (!row.active && !row.followed) return 'Paused'
  return row.followed ? 'Following' : 'Follow'
}
