/** Wallet byte normalization for issue #21 (no native imports — bun-testable).
 *
 * MWA results lie about shapes: `signature`/`signedMessage` may arrive as a
 * base64 string, raw bytes, a number array, or ASCII bytes OF base64 text
 * (double-encoded: 64-byte sig shows up as 88 bytes). This resolves all four
 * to the exact wire base64, logging which shape was seen.
 */
import { fromUint8Array, toUint8Array } from 'js-base64'

const B64_ALPHABET = /^[A-Za-z0-9+/=\s]+$/

function shapeOf(value: unknown): string {
  const record = value as { constructor?: { name?: string }; length?: unknown } | null
  return `${typeof value} ${record?.constructor?.name ?? '?'} len=${String(record?.length ?? '?')}`
}

/** Decode bytes to ASCII text, or null when unavailable/binary. */
function asciiOf(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder().decode(bytes)
    if (!B64_ALPHABET.test(text)) return null
    return text.replace(/\s/g, '')
  } catch {
    return null
  }
}

export function toWireBase64(value: unknown, label: string): string {
  console.log(`[b64] toWireBase64: ${label} shape=${shapeOf(value)}`)
  if (typeof value === 'string') {
    if (value.length === 88) {
      console.log(`[b64] toWireBase64: ${label} already base64, passthrough`)
      return value
    }
    console.log(`[b64] toWireBase64: ${label} raw string, encoding bytes`)
    return fromUint8Array(new TextEncoder().encode(value))
  }
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value as ArrayLike<number>)
  const ascii = asciiOf(bytes)
  if (ascii !== null) {
    try {
      const raw = toUint8Array(ascii)
      const text = new TextDecoder().decode(raw)
      // Double-encoded: ASCII text that is itself base64 of the real payload.
      // Accept when it decodes to SIWS text or exactly 64 signature bytes.
      if (text.includes('wants you to sign in with your Solana account') || raw.length === 64) {
        console.log(`[b64] toWireBase64: ${label} double-encoded, unwrapped one layer`)
        return ascii
      }
    } catch {
      // Not decodable base64 — fall through to raw encoding.
    }
  }
  console.log(`[b64] toWireBase64: ${label} raw bytes, encoding`)
  return fromUint8Array(bytes)
}
