/** Pure catalog/subscription merge for issue #22 (no RN imports — bun-testable).
 *
 * Rules (from docs/wallet-selection.md):
 * - New follows default to alerts OFF; omission preserves the existing preference.
 * - Paused (inactive) wallets: no new follows, no alert changes, existing follows stay visible.
 * - Unfollow never deletes shared history (client just drops the row).
 */
import type { CatalogWallet, WalletSubscription } from './wallets-api'

export type WalletRow = CatalogWallet & {
  followed: boolean
  alertsEnabled: boolean
  alertsEnabledAt: string | null
  followDisabled: boolean
}

/** Join catalog with the owner's follows. Paused wallets render disabled but stay listed. */
export function mergeCatalog(wallets: CatalogWallet[], subscriptions: WalletSubscription[]): WalletRow[] {
  console.log(`[wallets-state] mergeCatalog: ${wallets.length} wallets, ${subscriptions.length} follows`)
  const byId = new Map(subscriptions.map((s) => [s.walletId, s]))
  return wallets.map((wallet) => {
    const sub = byId.get(wallet.id)
    return {
      ...wallet,
      followed: sub !== undefined,
      alertsEnabled: sub?.alertsEnabled ?? false,
      alertsEnabledAt: sub?.alertsEnabledAt ?? null,
      followDisabled: !wallet.active,
    }
  })
}

/** Next alerts value for a toggle. Paused or unfollowed rows never toggle. */
export function nextAlertsValue(row: WalletRow): boolean | null {
  if (!row.followed || !row.active) return null
  return !row.alertsEnabled
}

/** Whether the follow button should offer "Follow" (vs "Following"). */
export function followLabel(row: WalletRow): 'Follow' | 'Following' | 'Paused' {
  if (!row.active) return 'Paused'
  return row.followed ? 'Following' : 'Follow'
}
