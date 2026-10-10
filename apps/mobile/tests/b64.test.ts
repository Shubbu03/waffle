/** Byte-shape unit tests for issue #21 (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { fromUint8Array } from 'js-base64'
import { toWireBase64 } from '../lib/b64'

const SIG64 = new Uint8Array(64).map((_, i) => i)
const SIG_B64 = fromUint8Array(SIG64) // 88 chars

describe('toWireBase64', () => {
  test('base64 string passes through', () => {
    expect(toWireBase64(SIG_B64)).toBe(SIG_B64)
  })

  test('raw 64 bytes encode to 88 chars', () => {
    expect(toWireBase64(SIG64)).toBe(SIG_B64)
  })

  test('number array encodes like bytes', () => {
    expect(toWireBase64([...SIG64])).toBe(SIG_B64)
  })

  test('double-encoded ASCII bytes unwrap one layer', () => {
    const doubleEncoded = new TextEncoder().encode(SIG_B64) // 88 ASCII bytes
    expect(doubleEncoded.length).toBe(88)
    expect(toWireBase64(doubleEncoded)).toBe(SIG_B64)
  })

  test('real message bytes encode normally', () => {
    const text = 'waffle.local wants you to sign in with your Solana account:\nabc'
    const bytes = new TextEncoder().encode(text)
    expect(toWireBase64(bytes)).toBe(fromUint8Array(bytes))
  })

  test('double-encoded message unwraps to its base64', () => {
    const text = 'waffle.local wants you to sign in with your Solana account:\nabc'
    const inner = fromUint8Array(new TextEncoder().encode(text))
    const doubleEncoded = new TextEncoder().encode(inner)
    expect(toWireBase64(doubleEncoded)).toBe(inner)
  })
})
