/** Unit tests for issue #21 session helpers (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { ApiError } from './api-error'
import { isSessionExpired, parseStoredSession } from './session'

describe('isSessionExpired', () => {
  const now = Date.parse('2026-09-30T10:00:00.000Z')

  test('future expiry is live', () => {
    expect(isSessionExpired('2026-09-30T11:00:00.000Z', now)).toBe(false)
  })

  test('past expiry is expired', () => {
    expect(isSessionExpired('2026-09-30T09:59:59.000Z', now)).toBe(true)
  })

  test('exact-now boundary counts as expired', () => {
    expect(isSessionExpired('2026-09-30T10:00:00.000Z', now)).toBe(true)
  })

  test('garbage timestamps fail closed (expired)', () => {
    expect(isSessionExpired('not-a-date', now)).toBe(true)
    expect(isSessionExpired('', now)).toBe(true)
  })
})

describe('ApiError', () => {
  test('carries status, code, message', () => {
    const error = new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired sign-in challenge')
    expect(error.status).toBe(401)
    expect(error.code).toBe('UNAUTHORIZED')
    expect(error.message).toContain('expired')
    expect(error instanceof Error).toBe(true)
  })
})

describe('parseStoredSession', () => {
  test('null and garbage fail closed', () => {
    expect(parseStoredSession(null)).toBeNull()
    expect(parseStoredSession('not-json')).toBeNull()
    expect(parseStoredSession(JSON.stringify({ userId: 'u' }))).toBeNull()
  })

  test('complete record parses', () => {
    const record = {
      userId: '11111111-1111-4111-8111-111111111111',
      walletAddress: '1'.repeat(32),
      expiresAt: '2026-10-08T10:00:00.000Z',
      accessToken: 'a'.repeat(43),
    }
    expect(parseStoredSession(JSON.stringify(record))).toEqual(record)
  })
})

test('legacy local sessions and malformed bearer tokens cannot restore authentication', () => {
  expect(
    parseStoredSession(
      JSON.stringify({
        userId: 'local',
        walletAddress: '1'.repeat(32),
        expiresAt: '2026-10-08T10:00:00Z',
        accessToken: '',
      }),
    ),
  ).toBeNull()
  expect(
    parseStoredSession(
      JSON.stringify({
        userId: '11111111-1111-4111-8111-111111111111',
        walletAddress: '1'.repeat(32),
        expiresAt: '2026-10-08T10:00:00Z',
        accessToken: 'short',
      }),
    ),
  ).toBeNull()
})
