/** Pure wallet-address prefilter for the track input (no RN imports — bun-testable).
 * This is a UX prefilter only; the server performs the authoritative on-curve check. */

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export type AddressCheck = { ok: true; address: string } | { ok: false; message: string }

/** Trim and validate a pasted address; returns a friendly message when it is not plausible. */
export function checkWalletAddress(input: string): AddressCheck {
  const address = input.trim()
  if (address.length === 0) return { ok: false, message: 'Paste a wallet address to track.' }
  if (!BASE58_ADDRESS.test(address)) {
    return { ok: false, message: 'That does not look like a Solana wallet address.' }
  }
  return { ok: true, address }
}

/** Map a server/network failure from tracking into a short, human message. */
export function trackErrorMessage(status: number, code: string): string {
  if (status === 422) {
    if (code === 'NO_HISTORY') return 'No transaction history found for this wallet.'
    if (code === 'UNSUPPORTED_WALLET') return 'No recent PumpSwap activity — waffle tracks PumpSwap buys only for now.'
    if (code === 'TOO_ACTIVE') return 'This wallet trades too often to track reliably.'
  }
  if (status === 429) return 'Too many attempts — wait a minute and try again.'
  if (status === 409)
    return code === 'CONFLICT' ? 'You can track up to 3 wallets.' : 'Tracking is at capacity right now.'
  if (status === 400) return 'Enter a valid on-curve Solana wallet address.'
  if (status === 401) return 'Sign in to track a wallet.'
  return 'Could not track that wallet. Try again.'
}
