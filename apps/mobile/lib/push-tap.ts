import { eventCursorSchema, idSchema, solanaAddressSchema, timestampSchema } from '@waffle/shared'

export type PushPermission = 'granted' | 'denied'
export type SignalPush = {
  id: string
  eventId: string
  score: number
  wallet: string
  mint: string
  slot: number
  expiresAt: number
}

/** Taps can open historical detail; freshness is enforced before displaying an alert. */
export function parseSignalTap(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const parsed = idSchema.safeParse((data as Record<string, unknown>).id)
  return parsed.success ? parsed.data : null
}

export function parseSignalPush(data: unknown, now = Date.now()): SignalPush | null {
  const id = parseSignalTap(data)
  if (!id || !data || typeof data !== 'object') return null
  const fields = data as Record<string, unknown>
  const eventId = eventCursorSchema.safeParse(fields.eventId)
  const wallet = solanaAddressSchema.safeParse(fields.wallet)
  const mint = solanaAddressSchema.safeParse(fields.mint)
  const expiry = timestampSchema.safeParse(fields.expiresAt)
  if (!eventId.success || !wallet.success || !mint.success || !expiry.success) return null
  if (typeof fields.score !== 'string' || !/^(0|[1-9]\d{0,2})$/.test(fields.score)) return null
  if (typeof fields.slot !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(fields.slot)) return null
  const score = Number(fields.score)
  const slot = Number(fields.slot)
  const expiresAt = Date.parse(expiry.data)
  if (score < 70 || score > 100 || !Number.isSafeInteger(slot) || expiresAt <= now || expiresAt > now + 90_000)
    return null
  return { id, eventId: eventId.data, wallet: wallet.data, mint: mint.data, score, slot, expiresAt }
}
