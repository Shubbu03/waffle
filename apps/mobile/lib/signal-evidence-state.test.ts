import { describe, expect, test } from 'bun:test'
import { signalFixture } from '../test-support/signal-fixture'
import { signalEvidenceLabel } from './signal-evidence-state'

describe('detail evidence freshness', () => {
  const now = 1_800_000_000_000
  test('a stored passing check expires without changing its historical score', () => {
    const signal = signalFixture(undefined, now)
    expect(signalEvidenceLabel(signal, 'pool', false, now)).toBe('Fresh')
    expect(signalEvidenceLabel(signal, 'pool', false, now + 15_000)).toBe('Expired')
    expect(signalEvidenceLabel(signal, 'quote', false, now + 10_001)).toBe('Expired')
    expect(signal.score).toBe(80)
  })
  test('cached, missing, and future evidence never appears fresh', () => {
    const signal = signalFixture(undefined, now)
    expect(signalEvidenceLabel(signal, 'mint', true, now)).toBe('Unknown')
    expect(signalEvidenceLabel(signal, 'holders', false, now)).toBe('Unavailable')
    expect(signalEvidenceLabel(signalFixture(undefined, now + 1), 'pool', false, now)).toBe('Unknown')
    signal.snapshot.assessment = undefined
    expect(signalEvidenceLabel(signal, 'mint', false, now)).toBe('Unknown')
  })
  test('evidence for another asset is not presented as a current check for this token', () => {
    const signal = signalFixture(undefined, now)
    if (signal.snapshot.pool) signal.snapshot.pool.baseMint = signal.walletAddress
    expect(signalEvidenceLabel(signal, 'pool', false, now)).toBe('Unknown')
  })
  test('missing expiry and explicit stale status retain their uncertainty', () => {
    const signal = signalFixture(undefined, now)
    const evidence = signal.snapshot.assessment?.evidence.mint
    if (!evidence) throw new Error('Fixture assessment missing')
    evidence.expiresAt = null
    expect(signalEvidenceLabel(signal, 'mint', false, now)).toBe('Unknown')
    evidence.status = 'stale'
    expect(signalEvidenceLabel(signal, 'mint', false, now)).toBe('Expired')
  })
})
