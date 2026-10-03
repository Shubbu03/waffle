/** Push helper unit tests for issue #24 (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { parseSignalTap, toPushPermission } from './push-tap'

describe('toPushPermission', () => {
  test('authorized or provisional count as granted', () => {
    expect(toPushPermission(true, false)).toBe('granted')
    expect(toPushPermission(false, true)).toBe('granted')
  })

  test('anything else stays undecided', () => {
    expect(toPushPermission(false, false)).toBe('default')
  })
})

describe('parseSignalTap', () => {
  test('routes a well-formed signal id', () => {
    expect(parseSignalTap({ signalId: 'abc-123' })).toBe('abc-123')
  })

  test('rejects garbage without throwing', () => {
    expect(parseSignalTap(null)).toBeNull()
    expect(parseSignalTap('abc')).toBeNull()
    expect(parseSignalTap({})).toBeNull()
    expect(parseSignalTap({ signalId: 42 })).toBeNull()
    expect(parseSignalTap({ signalId: '' })).toBeNull()
    expect(parseSignalTap({ signalId: 'x'.repeat(200) })).toBeNull()
  })
})
