/** Catalog state tests for issue #22 (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { followLabel, mergeCatalog, nextAlertsValue, type WalletRow } from './wallet-subscription-state'
import type { CatalogWallet, WalletSubscription } from './wallets-api'

const wallet = (override: Partial<CatalogWallet> = {}): CatalogWallet => ({
  id: 'wallet-1',
  address: '11111111111111111111111111111111',
  label: 'Trader',
  active: true,
  source: 'catalog',
  inclusionReason: 'evidence',
  recentSupportedActivityAt: null,
  ...override,
})

const sub = (override: Partial<WalletSubscription> = {}): WalletSubscription => ({
  walletId: 'wallet-1',
  alertsEnabled: false,
  alertsEnabledAt: null,
  createdAt: '2026-09-30T00:00:00.000Z',
  ...override,
})

const row = (override: Partial<WalletRow> = {}): WalletRow => ({
  ...wallet(),
  followed: false,
  alertsEnabled: false,
  alertsEnabledAt: null,
  followDisabled: false,
  trackedByMe: false,
  ...override,
})

describe('mergeCatalog', () => {
  test('unfollowed wallets default alerts off', () => {
    const [merged] = mergeCatalog([wallet()], [])
    expect(merged?.followed).toBe(false)
    expect(merged?.alertsEnabled).toBe(false)
    expect(merged?.followDisabled).toBe(false)
    expect(merged?.trackedByMe).toBe(false)
  })

  test('marks only wallets the user personally tracks', () => {
    const [a, b] = mergeCatalog(
      [wallet({ id: 'wallet-1' }), wallet({ id: 'wallet-2', source: 'user' })],
      [],
      ['wallet-2'],
    )
    expect(a?.trackedByMe).toBe(false)
    expect(b?.trackedByMe).toBe(true)
  })

  test('joins follows by wallet id', () => {
    const [merged] = mergeCatalog(
      [wallet(), wallet({ id: 'wallet-2' })],
      [sub({ walletId: 'wallet-2', alertsEnabled: true, alertsEnabledAt: '2026-09-30T01:00:00.000Z' })],
    )
    expect(merged?.followed).toBe(false)
  })

  test('paused followed wallets remain removable', () => {
    const [merged] = mergeCatalog([wallet({ active: false })], [sub()])
    expect(merged?.followed).toBe(true)
    expect(merged?.followDisabled).toBe(false)
    expect(followLabel(merged as WalletRow)).toBe('Following')
  })

  test('unknown subscription ids never invent rows', () => {
    expect(mergeCatalog([], [sub({ walletId: 'ghost' })])).toEqual([])
  })
})

describe('nextAlertsValue', () => {
  test('toggles on and off', () => {
    expect(nextAlertsValue(row({ followed: true, active: true, alertsEnabled: false }))).toBe(true)
    expect(nextAlertsValue(row({ followed: true, active: true, alertsEnabled: true }))).toBe(false)
  })

  test('unfollowed wallets cannot enable alerts, paused follows can only mute', () => {
    expect(nextAlertsValue(row({ followed: false, active: true }))).toBeNull()
    expect(nextAlertsValue(row({ followed: true, active: false, alertsEnabled: true }))).toBe(false)
    expect(nextAlertsValue(row({ followed: true, active: false, alertsEnabled: false }))).toBeNull()
  })
})

describe('followLabel', () => {
  test('Follow / Following / Paused', () => {
    expect(followLabel(row({ followed: false, active: true }))).toBe('Follow')
    expect(followLabel(row({ followed: true, active: true }))).toBe('Following')
    expect(followLabel(row({ followed: true, active: false }))).toBe('Following')
    expect(followLabel(row({ followed: false, active: false }))).toBe('Paused')
  })
})
