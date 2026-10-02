import { describe, expect, test } from 'bun:test'
import { signalFixture, summaryFixture } from '../test-support/signal-fixture'
import { ageLabel, copyBlockReason, mergeSignals, signalDataLabel } from './signal-state'

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
  test('offline, expired transaction and future timestamps block copying', () => {
    expect(copyBlockReason(signalFixture(undefined, now), true, now)).toContain('Reconnect')
    expect(copyBlockReason(signalFixture(undefined, now - 90_001), false, now)).toContain('stale')
    expect(copyBlockReason(signalFixture(undefined, now + 1000), false, now)).toContain('stale')
  })
  test('pool expiry, missing assessment and degraded transport block copying', () => {
    const signal = signalFixture(undefined, now)
    expect(copyBlockReason(signal, false, now + 15_000)).toContain('refreshing')
    signal.snapshot.assessment = undefined
    expect(copyBlockReason(signal, false, now)).toContain('unknown')
    const degraded = signalFixture(undefined, now)
    if (degraded.snapshot.assessment) degraded.snapshot.assessment.streamStale = true
    expect(copyBlockReason(degraded, false, now)).toContain('degraded')
  })
  test('unknown data and suppressed/history signals are never actionable', () => {
    const signal = signalFixture(undefined, now)
    expect(copyBlockReason({ ...signal, dataStatus: 'unknown' }, false, now)).toContain('unknown')
    expect(copyBlockReason({ ...signal, status: 'suppressed' }, false, now)).toContain('blocked')
    expect(copyBlockReason({ ...signal, status: 'history-only' }, false, now)).toContain('history')
    expect(signalDataLabel(signal, true, now)).toBe('Cached · stale')
    expect(signalDataLabel({ ...signal, dataStatus: 'unknown' }, false, now)).toBe('Unknown data')
  })
  test('age uses explicit unknown states', () => {
    expect(ageLabel(null, now)).toBe('Age unknown')
    expect(ageLabel('not-a-date', now)).toBe('Age unknown')
    expect(ageLabel(new Date(now + 1).toISOString(), now)).toBe('Age unknown')
    expect(ageLabel(new Date(now - 61_000).toISOString(), now)).toBe('1m ago')
  })
})
