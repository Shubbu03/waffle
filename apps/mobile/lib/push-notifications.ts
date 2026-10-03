import notifee, { AndroidImportance } from '@notifee/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { idSchema, type SignalDetail } from '@waffle/shared'
import { AppConfig } from '@/constants/app-config'
import { pushDevice, readPushPermission, readPushRegistration, SIGNAL_CHANNEL } from './push-device'
import { receiveSignalPush, type SeenPush } from './push-receiver'
import { parseSignalTap, type SignalPush } from './push-tap'
import { isSessionExpired } from './session'
import { loadSession } from './session-store'
import { getSignal } from './signals-api'

const TAP_KEY = 'waffle.push-tap.v1'
export type PushTap = { id: string; userId: string }
const tapListeners = new Set<(tap: PushTap) => void>()

export function onPushTap(listener: (tap: PushTap) => void): () => void {
  tapListeners.add(listener)
  return () => {
    tapListeners.delete(listener)
  }
}

function parseTap(data: unknown): PushTap | null {
  const id = parseSignalTap(data)
  if (!id || !data || typeof data !== 'object') return null
  const owner = idSchema.safeParse((data as Record<string, unknown>).userId)
  return owner.success ? { id, userId: owner.data } : null
}

export async function queuePushTap(data: unknown): Promise<void> {
  const tap = parseTap(data)
  if (!tap) return
  await AsyncStorage.setItem(TAP_KEY, JSON.stringify(tap))
  for (const listener of tapListeners) listener(tap)
}

export async function readPendingPushTap(): Promise<PushTap | null> {
  const raw = await AsyncStorage.getItem(TAP_KEY)
  if (!raw) return null
  try {
    return parseTap(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function clearPendingPushTap(): Promise<void> {
  await AsyncStorage.removeItem(TAP_KEY)
}

function seenKey(owner: string): string {
  return `waffle.push-seen.v1:${encodeURIComponent(AppConfig.apiUrl)}:${owner}`
}

export async function receivePush(
  data: unknown,
  foreground?: (signal: SignalDetail, push: SignalPush) => void,
): Promise<void> {
  await pushDevice.run(async () => {
    const session = await loadSession()
    const registration = await readPushRegistration()
    if (
      !session ||
      isSessionExpired(session.expiresAt) ||
      registration?.rotationRequired ||
      registration?.userId !== session.userId ||
      registration.apiUrl !== AppConfig.apiUrl
    )
      return
    await receiveSignalPush(
      {
        now: Date.now,
        loadSeen: async (owner) => {
          const raw = await AsyncStorage.getItem(seenKey(owner))
          if (!raw) return []
          try {
            const entries: unknown = JSON.parse(raw)
            return Array.isArray(entries)
              ? entries
                  .slice(-200)
                  .filter(
                    (entry): entry is SeenPush =>
                      entry && idSchema.safeParse(entry.id).success && Number.isFinite(entry.expiresAt),
                  )
              : []
          } catch {
            return []
          }
        },
        saveSeen: (owner, seen) => AsyncStorage.setItem(seenKey(owner), JSON.stringify(seen)),
        signal: getSignal,
      },
      data,
      session.userId,
      async () =>
        pushDevice.canDeliver(session.userId) &&
        !isSessionExpired(session.expiresAt) &&
        (await readPushPermission()) === 'granted',
      async (signal, push) => {
        if (foreground) {
          foreground(signal, push)
          return
        }
        await notifee.displayNotification({
          id: push.id,
          title: `Whale alert · ${signal.score}/100`,
          body: 'Tap to reload the signal. Review a fresh quote before copying.',
          data: { id: push.id, userId: session.userId },
          android: {
            channelId: SIGNAL_CHANNEL,
            importance: AndroidImportance.HIGH,
            pressAction: { id: 'default' },
            onlyAlertOnce: true,
            autoCancel: true,
            timeoutAfter: Math.max(1, push.expiresAt - Date.now()),
          },
        })
        // Session end invalidates delivery immediately, even while native display is in flight.
        if (!pushDevice.canDeliver(session.userId)) await notifee.cancelNotification(push.id)
      },
    )
  })
}
