import { paymentSizeAllowed, realTradePolicy, WRAPPED_SOL_MINT } from '@waffle/shared'
/** Client-side real-trade guards.
 *
 * The server already enforces these in contract; the app re-checks every one
 * BEFORE asking the wallet to sign. Any failure renders `paper only` — never sign.
 * Allowed routers: metis | dflow | okx. JupiterZ is excluded (needs 2 signers,
 * which MWA signTransactions cannot produce).
 */

export const ALLOWED_ROUTERS = ['metis', 'dflow', 'okx'] as const

export type GuardResult = { ok: true } | { ok: false; reason: string }

type RealOrderLike = {
  network?: unknown
  kind?: unknown
  router?: unknown
  taker?: unknown
  signatureFeePayer?: unknown
  requiredSignatures?: unknown
  gasless?: unknown
  inputMint?: unknown
  slippageBps?: unknown
  priceImpactBps?: unknown
  feeLamports?: unknown
  inputAmountRaw?: unknown
  expiresAt?: unknown
  fetchedAt?: unknown
}

function fail(reason: string): GuardResult {
  return { ok: false, reason }
}

/** All gates for a server-issued real order, checked on-device pre-sign. */
export function checkRealOrder(
  order: unknown,
  connectedTaker: string,
  nowMs: number = Date.now(),
  network: 'mainnet' | 'devnet' | 'testnet' = 'mainnet',
): GuardResult {
  if (order === null || typeof order !== 'object') return fail('order missing')
  const o = order as RealOrderLike
  if (o.kind !== 'real') return fail(`kind=${String(o.kind)} (expected real)`)
  if ((o.network ?? 'mainnet') !== network || network === 'testnet')
    return fail('Order belongs to another network or trading is unavailable.')
  if (network !== 'mainnet' && o.inputMint !== undefined && o.inputMint !== WRAPPED_SOL_MINT)
    return fail('USDC trading is available on Mainnet only')
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
  const amount = typeof o.inputAmountRaw === 'string' ? Number(o.inputAmountRaw) : NaN
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail('unreadable input amount')
  if (!paymentSizeAllowed(typeof o.inputMint === 'string' ? o.inputMint : WRAPPED_SOL_MINT, String(amount), 'real'))
    return fail('Purchase exceeds the selected asset limit')
  if (
    o.slippageBps !== undefined &&
    (typeof o.slippageBps !== 'number' || o.slippageBps > realTradePolicy.maxSlippageBps)
  )
    return fail('Slippage exceeds the purchase limit')
  if (
    o.priceImpactBps !== undefined &&
    (typeof o.priceImpactBps !== 'number' || o.priceImpactBps > realTradePolicy.maxPriceImpactBps)
  )
    return fail('Price impact exceeds the purchase limit')
  if (
    o.feeLamports !== undefined &&
    (typeof o.feeLamports !== 'string' ||
      !/^\d+$/.test(o.feeLamports) ||
      BigInt(o.feeLamports) > realTradePolicy.maxFeeLamports)
  )
    return fail('Network fees exceed the purchase limit')
  const fetchedAt = typeof o.fetchedAt === 'string' ? Date.parse(o.fetchedAt) : NaN
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt > nowMs ||
    nowMs - fetchedAt >= (network === 'devnet' ? 60_000 : realTradePolicy.quoteMs)
  )
    return fail('quote expired')
  const expires = typeof o.expiresAt === 'string' ? Date.parse(o.expiresAt) : NaN
  if (!Number.isFinite(expires) || expires <= nowMs) return fail('quote expired')
  return { ok: true }
}
