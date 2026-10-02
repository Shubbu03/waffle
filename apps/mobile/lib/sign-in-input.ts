/** Local SIWS input for stateless sign-in (no native imports — bun-testable).
 * The server checks domain/uri/freshness/signature; the nonce is display-only
 * hygiene since freshness (not stored state) bounds replay to the skew window. */

export const SIGN_IN_STATEMENT = 'Sign in to waffle. This does not authorize any transactions.'

export type SignInInput = {
  domain: string
  statement: string
  uri: string
  version: '1'
  chainId: 'solana:mainnet'
  nonce: string
  issuedAt: string
  expirationTime: string
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Build a fresh input; throws on non-HTTPS uri (fail fast, never sign garbage). */
export function buildSignInInput(uri: string, now: number = Date.now()): SignInInput {
  console.log('[sign-in-input] buildSignInInput: constructing local input')
  const url = new URL(uri)
  if (url.protocol !== 'https:') throw new Error('SIWS URI must use HTTPS')
  const input: SignInInput = {
    domain: url.host,
    statement: SIGN_IN_STATEMENT,
    uri: url.href,
    version: '1',
    chainId: 'solana:mainnet',
    nonce: randomNonce(),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + 5 * 60_000).toISOString(),
  }
  console.log(`[sign-in-input] buildSignInInput: domain=${input.domain} issued=${input.issuedAt}`)
  return input
}
