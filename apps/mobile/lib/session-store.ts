/** Secure session persistence for issue #21. Values never hit console.log. */
import * as SecureStore from 'expo-secure-store'
import { parseStoredSession, type StoredSession } from './session'

export type { StoredSession } from './session'

const SESSION_KEY = 'waffle.session.v1'

/** Persist after verify. Overwrites any previous session. */
export async function saveSession(
  session: Omit<StoredSession, 'accessToken'> & { accessToken: string },
): Promise<void> {
  console.log('[session] saveSession: writing keychain entry')
  await SecureStore.setItemAsync(
    SESSION_KEY,
    JSON.stringify({
      userId: session.userId,
      walletAddress: session.walletAddress,
      expiresAt: session.expiresAt,
      accessToken: session.accessToken,
    }),
  )
  console.log('[session] saveSession: stored')
}

/** Load on launch. Null = signed out (or corrupt entry, treated as signed out). */
export async function loadSession(): Promise<StoredSession | null> {
  console.log('[session] loadSession: reading keychain entry')
  const stored = parseStoredSession(await SecureStore.getItemAsync(SESSION_KEY))
  console.log(`[session] loadSession: ${stored ? 'found' : 'empty'}`)
  return stored
}

/** Clear on logout. Never throws — callers must not get stuck signed in. */
export async function clearSession(): Promise<void> {
  console.log('[session] clearSession: deleting keychain entry')
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY)
  } catch {
    console.log('[session] clearSession: nothing to delete')
  }
  console.log('[session] clearSession: done')
}
