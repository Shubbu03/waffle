import * as SecureStore from 'expo-secure-store'
import { parseStoredSession, type StoredSession } from './session'

export type { StoredSession } from './session'

const SESSION_KEY = 'waffle.session.v1'

export async function saveSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session))
}
export async function loadSession(): Promise<StoredSession | null> {
  return parseStoredSession(await SecureStore.getItemAsync(SESSION_KEY))
}
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY)
}
