import { describe, expect, test } from 'bun:test'
import { ageLabel, copyBlockReason, mergeSignals, signalDataLabel } from '../lib/signal-state'
import { signalFixture, summaryFixture } from './fixtures/signal-fixture'

describe('signal presentation and copy safety', () => {
  const now = Date.now()
  test('bigint event order and signal deduplication survive replay', () => {
    const older = summaryFixture('9007199254740992', now)
    const newer = summaryFixture('9007199254740993', now)
    expect(mergeSignals([older, newer], [newer])).toEqual([newer, older])
    expect(
      mergeSignals(
        [],
        Array.from({ length: 205 }, (_, i) => summaryFixture(String(i + 1))),
      ),
    ).toHaveLength(205)
  })
  test('missing optional holders/oracle does not block fresh critical checks', () => {
    const signal = signalFixture(undefined, now)
    expect(signal.snapshot.holders).toBeNull()
    expect(copyBlockReason(signal, false, now)).toBeNull()
  })
  test('offline and unsupported transactions block review', () => {
    expect(copyBlockReason(signalFixture(undefined, now), true, now)).toContain('Reconnect')
    const signal = signalFixture(undefined, now)
    signal.reasons = signal.reasons.map((r) =>
      r.code === 'supported_buy' ? { code: 'unsupported_or_failed_transaction', points: 0 } : r,
    )
    expect(copyBlockReason(signal, false, now)).toContain('not a confirmed supported buy')
  })
  test('historical, suppressed and expired snapshots may request current server checks', () => {
    const signal = signalFixture(undefined, now - 86400_000)
    for (const status of ['eligible', 'suppressed', 'history-only'] as const) {
      expect(copyBlockReason({ ...signal, status }, false, now)).toBeNull()
    }
    signal.snapshot.assessment = undefined
    expect(copyBlockReason(signal, false, now)).toBeNull()
    expect(signalDataLabel(signal, true, now)).toBe('Cached · stale')
    expect(signalDataLabel(signal, false, now)).toBe('Earlier buy')
  })
  test('age uses explicit unknown states', () => {
    expect(ageLabel(null, now)).toBe('Age unknown')
    expect(ageLabel('not-a-date', now)).toBe('Age unknown')
    expect(ageLabel(new Date(now + 1).toISOString(), now)).toBe('Age unknown')
    expect(ageLabel(new Date(now - 61_000).toISOString(), now)).toBe('1m ago')
  })
})
