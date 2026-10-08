/** Client-side real-trade guards for issue #27 (no native imports — bun-testable).
 *
 * The server already enforces these in contract; the app re-checks every one
 * BEFORE asking the wallet to sign. Any failure renders `paper only` — never sign.
 * Allowed routers: metis | dflow | okx. JupiterZ is excluded (needs 2 signers,
 * which MWA signTransactions cannot produce).
 */

export const ALLOWED_ROUTERS = ['metis', 'dflow', 'okx'] as const
export const REAL_MAX_LAMPORTS = 50_000_000 // 0.05 SOL demo cap (mirrors scorePolicyV1.sizeLamports.realMax)

export type GuardResult = { ok: true } | { ok: false; reason: string }

type RealOrderLike = {
  network?: unknown
  kind?: unknown
  router?: unknown
  taker?: unknown
  signatureFeePayer?: unknown
  requiredSignatures?: unknown
  gasless?: unknown
  inputAmountLamports?: unknown
  expiresAt?: unknown
  fetchedAt?: unknown
}

function fail(reason: string): GuardResult {
  console.log(`[trade-guard] REJECT: ${reason}`)
  return { ok: false, reason }
}

/** All gates for a server-issued real order, checked on-device pre-sign. */
export function checkRealOrder(
  order: unknown,
  connectedTaker: string,
  nowMs: number = Date.now(),
  network: 'mainnet' | 'devnet' | 'testnet' = 'mainnet',
): GuardResult {
  console.log('[trade-guard] checkRealOrder: evaluating gates')
  if (order === null || typeof order !== 'object') return fail('order missing')
  const o = order as RealOrderLike
  if (o.kind !== 'real') return fail(`kind=${String(o.kind)} (expected real)`)
  if ((o.network ?? 'mainnet') !== network || network === 'testnet')
    return fail('Order belongs to another network or trading is unavailable.')
  const routers = network === 'devnet' ? ['pumpswap'] : ALLOWED_ROUTERS
  if (typeof o.router !== 'string' || !(routers as readonly string[]).includes(o.router)) {
    return fail(`router=${String(o.router)} (need ${routers.join('/')}, never jupiterz)`)
  }
  if (typeof o.taker !== 'string' || o.taker !== connectedTaker) {
    return fail('taker is not the connected wallet')
  }
  if (o.signatureFeePayer !== o.taker) return fail('fee payer differs from taker (gasless/sponsored route)')
  if (o.requiredSignatures !== 1) return fail(`requiredSignatures=${String(o.requiredSignatures)} (need exactly 1)`)
  if (o.gasless !== false) return fail('gasless route')
  const amount = typeof o.inputAmountLamports === 'string' ? Number(o.inputAmountLamports) : NaN
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail('unreadable input amount')
  if (amount > REAL_MAX_LAMPORTS) return fail(`exceeds 0.05 SOL demo cap (${amount} lamports)`)
  const fetchedAt = typeof o.fetchedAt === 'string' ? Date.parse(o.fetchedAt) : NaN
  if (!Number.isFinite(fetchedAt) || fetchedAt > nowMs || nowMs - fetchedAt >= (network === 'devnet' ? 60_000 : 10_000))
    return fail('quote expired')
  const expires = typeof o.expiresAt === 'string' ? Date.parse(o.expiresAt) : NaN
  if (!Number.isFinite(expires) || expires <= nowMs) return fail('quote expired')
  console.log('[trade-guard] checkRealOrder: all gates pass')
  return { ok: true }
}
