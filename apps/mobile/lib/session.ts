/** Pure session shapes and checks (no native imports — safe for bun test). */

export type StoredSession = {
  userId: string
  walletAddress: string
  expiresAt: string
  accessToken: string
}

export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.walletAddress !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.accessToken !== 'string'
    ) {
      return null
    }
    return parsed as StoredSession
  } catch {
    return null
  }
}

/** Expired or unparseable => true (fail closed). */
export function isSessionExpired(expiresAt: string, now: number = Date.now()): boolean {
  const expires = Date.parse(expiresAt)
  return !Number.isFinite(expires) || expires <= now
}
