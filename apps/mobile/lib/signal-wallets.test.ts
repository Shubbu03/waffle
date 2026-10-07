import { expect, test } from 'bun:test'
import { summaryFixture } from '../test-support/signal-fixture'
import { signalWallets } from './signal-wallets'
import type { CatalogWallet } from './wallets-api'

const first = summaryFixture('1', Date.parse('2026-10-03T10:00:00Z'))
const busy: CatalogWallet = {
  id: first.walletId,
  address: first.walletAddress,
  label: 'Busy wallet',
  active: true,
  inclusionReason: 'Reviewed',
  recentSupportedActivityAt: null,
}
const quiet: CatalogWallet = { ...busy, id: crypto.randomUUID(), label: 'Quiet wallet' }

test('wallet index deduplicates a busy first page without hiding wallets outside that page', () => {
  const transactions = Array.from({ length: 50 }, (_, i) =>
    summaryFixture(String(i + 1), Date.parse('2026-10-03T10:00:00Z')),
  )
  const rows = signalWallets([quiet, busy], transactions, 'all', null)
  expect(rows.map((row) => row.id)).toEqual([busy.id, quiet.id])
  expect(rows[0]?.latestActivityAt).toBe(transactions[0]?.observedAt)
  expect(rows[1]?.latestActivityAt).toBeNull()
})

test('Following uses follows, including paused wallets, and excludes removed follows with cached signals', () => {
  const paused = { ...quiet, active: false }
  expect(signalWallets([busy, paused], [first], 'following', [paused.id])).toEqual([
    { id: paused.id, address: paused.address, label: paused.label, active: false, latestActivityAt: null },
  ])
  expect(signalWallets([busy, quiet], [first], 'following', [])).toEqual([])
})

test('unknown offline Following membership only restores wallets from saved Following signals', () => {
  const rows = signalWallets([busy, quiet], [first], 'following', null)
  expect(rows.map((row) => row.id)).toEqual([busy.id])
  expect(rows[0]?.label).toBe(busy.label)
})

test('catalog failure still permits distinct saved wallets ordered by their newest observed buy', () => {
  const earlier = { ...first, observedAt: '2026-10-01T10:00:00Z' }
  const later = { ...summaryFixture('2'), walletId: quiet.id, observedAt: '2026-10-02T10:00:00Z' }
  const rows = signalWallets([], [earlier, first, later], 'all', null)
  expect(rows).toHaveLength(2)
  expect(rows.find((row) => row.id === quiet.id)?.address).toBe(later.walletAddress)
  expect(rows[0]?.latestActivityAt).toBe(first.observedAt)
})
