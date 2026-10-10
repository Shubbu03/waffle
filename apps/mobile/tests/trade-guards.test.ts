/** Real-trade guard tests for issue #27 (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { checkRealOrder } from '../lib/trade-guards'

const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const TAKER = 'Taker111111111111111111111111111111111111111'

const goodOrder = () => ({
  kind: 'real',
  router: 'metis',
  taker: TAKER,
  signatureFeePayer: TAKER,
  requiredSignatures: 1,
  gasless: false,
  inputAmountLamports: '10000000',
  expiresAt: new Date(NOW + 60_000).toISOString(),
  fetchedAt: new Date(NOW - 1000).toISOString(),
})

describe('checkRealOrder', () => {
  test('clean metis order passes', () => {
    expect(checkRealOrder(goodOrder(), TAKER, NOW)).toEqual({ ok: true })
  })

  test('each supported router passes', () => {
    for (const router of ['metis', 'dflow', 'okx']) {
      expect(checkRealOrder({ ...goodOrder(), router }, TAKER, NOW)).toEqual({ ok: true })
    }
  })

  test('rejects jupiterz and unknown routers', () => {
    for (const router of ['jupiterz', 'unknown', '', undefined]) {
      const result = checkRealOrder({ ...goodOrder(), router }, TAKER, NOW)
      expect(result.ok).toBe(false)
    }
  })

  test('rejects taker mismatch and fee-payer mismatch', () => {
    expect(checkRealOrder(goodOrder(), 'Other1111111111111111111111111111111111111', NOW).ok).toBe(false)
    expect(
      checkRealOrder({ ...goodOrder(), signatureFeePayer: 'Sponsor11111111111111111111111111111111' }, TAKER, NOW),
    ).toEqual({
      ok: false,
      reason: 'fee payer differs from taker (gasless/sponsored route)',
    })
  })

  test('rejects multi-signer and gasless routes', () => {
    expect(checkRealOrder({ ...goodOrder(), requiredSignatures: 2 }, TAKER, NOW).ok).toBe(false)
    expect(checkRealOrder({ ...goodOrder(), gasless: true }, TAKER, NOW).ok).toBe(false)
  })

  test('rejects paper kind and over-cap amounts', () => {
    expect(checkRealOrder({ ...goodOrder(), kind: 'paper' }, TAKER, NOW).ok).toBe(false)
    expect(checkRealOrder({ ...goodOrder(), inputAmountLamports: '60000000' }, TAKER, NOW)).toEqual({
      ok: false,
      reason: 'exceeds 0.05 SOL demo cap (60000000 lamports)',
    })
    expect(checkRealOrder({ ...goodOrder(), inputAmountLamports: 'not-a-number' }, TAKER, NOW).ok).toBe(false)
  })

  test('rejects expired quotes', () => {
    expect(checkRealOrder({ ...goodOrder(), expiresAt: new Date(NOW - 1000).toISOString() }, TAKER, NOW).ok).toBe(false)
  })

  test('rejects future and aged quotes even with a later expiry', () => {
    expect(checkRealOrder({ ...goodOrder(), fetchedAt: new Date(NOW + 1).toISOString() }, TAKER, NOW).ok).toBe(false)
    expect(checkRealOrder({ ...goodOrder(), fetchedAt: new Date(NOW - 10000).toISOString() }, TAKER, NOW).ok).toBe(
      false,
    )
  })

  test('rejects garbage input', () => {
    expect(checkRealOrder(null, TAKER, NOW).ok).toBe(false)
    expect(checkRealOrder('order', TAKER, NOW).ok).toBe(false)
    expect(checkRealOrder({}, TAKER, NOW).ok).toBe(false)
  })
})

test('Devnet orders stay on Devnet and use their own freshness window', () => {
  const order = {
    ...goodOrder(),
    network: 'devnet',
    router: 'pumpswap',
    fetchedAt: new Date(NOW - 15_000).toISOString(),
  }
  expect(checkRealOrder(order, TAKER, NOW, 'devnet').ok).toBe(true)
  expect(checkRealOrder(order, TAKER, NOW, 'mainnet').ok).toBe(false)
  expect(checkRealOrder(goodOrder(), TAKER, NOW, 'devnet').ok).toBe(false)
  expect(checkRealOrder({ ...order, router: 'metis' }, TAKER, NOW, 'devnet').ok).toBe(false)
  expect(checkRealOrder({ ...order, fetchedAt: new Date(NOW - 60_000).toISOString() }, TAKER, NOW, 'devnet').ok).toBe(
    false,
  )
  expect(checkRealOrder({ ...order, network: 'testnet' }, TAKER, NOW, 'testnet').ok).toBe(false)
})
