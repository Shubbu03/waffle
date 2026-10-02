import { authVerifyResponseSchema, type Session } from '@waffle/shared'

export type StoredSession = Session & { accessToken: string }

export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null
  try {
    const { accessToken, ...session } = JSON.parse(raw)
    const parsed = authVerifyResponseSchema.safeParse({ session, accessToken })
    return parsed.success ? { ...parsed.data.session, accessToken: parsed.data.accessToken } : null
  } catch {
    return null
  }
}

export function isSessionExpired(expiresAt: string, now: number = Date.now()): boolean {
  const expires = Date.parse(expiresAt)
  return !Number.isFinite(expires) || expires <= now
}
