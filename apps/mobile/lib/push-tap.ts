/** Pure push helpers for issue #24 (no native imports — bun-testable). */

export type PushPermission = 'granted' | 'denied' | 'default'

/** Map an RNFirebase authorization status code to our tri-state. */
export function toPushPermission(authorized: boolean, provisional: boolean): PushPermission {
  if (authorized) return 'granted'
  if (provisional) return 'granted'
  return 'default'
}

/** A tap is only routable when it carries a sane signal id. Never throws. */
export function parseSignalTap(data: unknown): string | null {
  console.log('[push-tap] parseSignalTap: inspecting payload')
  if (data === null || typeof data !== 'object') return null
  const signalId = (data as Record<string, unknown>).signalId
  if (typeof signalId !== 'string' || signalId.length < 1 || signalId.length > 128) {
    console.log('[push-tap] parseSignalTap: no routable signal id')
    return null
  }
  console.log(`[push-tap] parseSignalTap: signal ${signalId.slice(0, 8)}...`)
  return signalId
}
