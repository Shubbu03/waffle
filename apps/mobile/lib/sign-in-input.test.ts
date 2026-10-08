/** Unit tests for stateless SIWS input (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { buildSignInInput, SIGN_IN_STATEMENT } from './sign-in-input'

describe('buildSignInInput', () => {
  test('signs the selected network on Mainnet, Devnet and Testnet', () => {
    for (const chain of ['solana:mainnet', 'solana:devnet', 'solana:testnet'] as const) {
      const input = buildSignInInput('https://waffle.local', Date.now(), chain)
      expect(input.chainId).toBe(chain)
    }
  })
  test('derives domain, fixes chain and statement', () => {
    const input = buildSignInInput('https://waffle.local', Date.parse('2026-09-30T10:00:00.000Z'))
    expect(input.domain).toBe('waffle.local')
    expect(input.uri).toBe('https://waffle.local/')
    expect(input.version).toBe('1')
    expect(input.chainId).toBe('solana:mainnet')
    expect(input.statement).toBe(SIGN_IN_STATEMENT)
  })

  test('freshness window is five minutes with unique nonces', () => {
    const now = Date.parse('2026-09-30T10:00:00.000Z')
    const a = buildSignInInput('https://waffle.local', now)
    const b = buildSignInInput('https://waffle.local', now)
    expect(a.nonce).toMatch(/^[a-f0-9]{32}$/)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.issuedAt).toBe('2026-09-30T10:00:00.000Z')
    expect(Date.parse(a.expirationTime) - Date.parse(a.issuedAt)).toBe(300_000)
  })

  test('rejects non-HTTPS identity fast', () => {
    expect(() => buildSignInInput('http://waffle.local')).toThrow('HTTPS')
    expect(() => buildSignInInput('not-a-url')).toThrow()
  })
})
