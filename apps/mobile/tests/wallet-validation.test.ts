/** Track-input validation tests (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { checkWalletAddress, trackErrorMessage } from '../lib/wallet-validation'

const VALID = 'So11111111111111111111111111111111111111112'

describe('checkWalletAddress', () => {
  test('accepts a plausible base58 address and trims whitespace', () => {
    expect(checkWalletAddress(`  ${VALID}  `)).toEqual({ ok: true, address: VALID })
  })

  test('rejects empty input with a prompt', () => {
    const result = checkWalletAddress('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('Paste')
  })

  test('rejects characters outside base58 and wrong lengths', () => {
    expect(checkWalletAddress('0OIl').ok).toBe(false)
    expect(checkWalletAddress('abc').ok).toBe(false)
    expect(checkWalletAddress('x'.repeat(45)).ok).toBe(false)
  })
})

describe('trackErrorMessage', () => {
  test('maps the meaningful failures to short messages', () => {
    expect(trackErrorMessage(409, 'CONFLICT')).toContain('3 wallets')
    expect(trackErrorMessage(400, 'VALIDATION_ERROR')).toContain('valid')
    expect(trackErrorMessage(401, 'UNAUTHORIZED')).toContain('Sign in')
    expect(trackErrorMessage(500, 'INTERNAL_ERROR')).toContain('Try again')
  })

  test('maps validation rejections and rate limits', () => {
    expect(trackErrorMessage(422, 'NO_HISTORY')).toContain('history')
    expect(trackErrorMessage(422, 'UNSUPPORTED_WALLET')).toContain('PumpSwap')
    expect(trackErrorMessage(422, 'TOO_ACTIVE')).toContain('too often')
    expect(trackErrorMessage(429, 'RATE_LIMITED')).toContain('Too many')
  })
})
