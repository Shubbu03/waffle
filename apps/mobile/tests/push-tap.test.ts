import { describe, expect, test } from 'bun:test'
import { parseSignalPush, parseSignalTap } from '../lib/push-tap'
import { pushFixture } from './fixtures/push-fixture'

describe('signal push contract', () => {
  test('accepts the actual backend wire fields and preserves bigint event IDs', () => {
    const now = Date.now()
    const { data } = pushFixture(now)
    expect(parseSignalTap(data)).toBe(data.id)
    expect(parseSignalPush(data, now)).toMatchObject({ id: data.id, eventId: data.eventId, score: 80, slot: 100 })
  })
  test('rejects malformed IDs and the obsolete signalId field', () => {
    for (const data of [
      null,
      'abc',
      {},
      { signalId: crypto.randomUUID() },
      { id: 42 },
      { id: '' },
      { id: '../sign-in' },
      { id: 'x'.repeat(200) },
    ])
      expect(parseSignalTap(data)).toBeNull()
  })
  test('drops expired, malformed and excessively long-lived pushes before receipt', () => {
    const now = Date.now()
    const { data } = pushFixture(now)
    for (const changes of [
      { expiresAt: new Date(now).toISOString() },
      { expiresAt: 'bad' },
      { expiresAt: new Date(now + 90_001).toISOString() },
      { wallet: 'bad' },
      { mint: 'bad' },
      { score: '69' },
      { score: '101' },
      { slot: '9007199254740992' },
      { eventId: '0' },
    ])
      expect(parseSignalPush({ ...data, ...changes }, now)).toBeNull()
    expect(parseSignalTap({ ...data, expiresAt: 'expired' })).toBe(data.id)
  })
})
