import {
  AuthorizationStatus,
  getInitialNotification,
  getMessaging,
  getToken,
  hasPermission,
  onMessage,
  onNotificationOpenedApp,
  onTokenRefresh,
  type RemoteMessage,
  requestPermission,
} from '@react-native-firebase/messaging'
import { router } from 'expo-router'
import * as SecureStore from 'expo-secure-store'
import { createContext, type PropsWithChildren, use, useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { type PushPermission, parseSignalTap, toPushPermission } from '@/lib/push-tap'
import { deletePushToken, PUSH_ID_KEY, registerPushToken } from '@/lib/push-tokens-api'

export interface PushState {
  permission: PushPermission
  foregroundSignalId: string | null
  dismissForeground: () => void
}

const Context = createContext<PushState>({} as PushState)

export function usePush() {
  const value = use(Context)
  if (!value) throw new Error('usePush must be wrapped in <PushProvider />')
  return value
}

function routeToSignal(signalId: string, source: string): void {
  console.log(`[push] routing to signal from ${source}`)
  router.push(`/signals/${signalId}`)
}

export function PushProvider({ children }: PropsWithChildren) {
  const { session } = useAuth()
  const token = session?.accessToken ?? ''
  const [permission, setPermission] = useState<PushPermission>('default')
  const [foregroundSignalId, setForegroundSignalId] = useState<string | null>(null)

  /** Permission + registration, re-run on sign-in. Denial is a state, never a crash. */
  useEffect(() => {
    if (!token) {
      console.log('[push] no session, skipping registration')
      return
    }
    const messaging = getMessaging()
    let cancelled = false
    async function setup(): Promise<void> {
      console.log('[push] setup: checking permission')
      const current = await hasPermission(messaging)
      let state = toPushPermission(
        current === AuthorizationStatus.AUTHORIZED,
        current === AuthorizationStatus.PROVISIONAL,
      )
      console.log(`[push] setup: current=${current} -> ${state}`)
      if (state === 'default') {
        console.log('[push] setup: requesting permission')
        const next = await requestPermission(messaging)
        state = toPushPermission(next === AuthorizationStatus.AUTHORIZED, next === AuthorizationStatus.PROVISIONAL)
        console.log(`[push] setup: requested -> ${state}`)
      }
      if (cancelled) return
      setPermission(state)
      console.log('[push] setup: fetching FCM token')
      const fcmToken = await getToken(messaging)
      if (cancelled) return
      console.log('[push] setup: token received (value hidden), registering')
      const registration = await registerPushToken(token, {
        token: fcmToken,
        platform: 'android',
        notificationPermission: state === 'granted' ? 'granted' : 'denied',
      })
      await SecureStore.setItemAsync(PUSH_ID_KEY, registration.id)
      console.log('[push] setup: registered')
    }
    setup().catch((error: unknown) => {
      console.log(`[push] setup failed (${error instanceof Error ? error.message : 'unknown'}) — alerts off, app works`)
      if (!cancelled) setPermission('denied')
    })
    return () => {
      cancelled = true
    }
  }, [token])

  /** Token rotation: delete old id, register new. */
  useEffect(() => {
    if (!token) return
    const messaging = getMessaging()
    console.log('[push] watching token refresh')
    const unsubscribe = onTokenRefresh(messaging, async (fcmToken) => {
      console.log('[push] token refreshed, re-registering')
      try {
        const oldId = await SecureStore.getItemAsync(PUSH_ID_KEY)
        if (oldId) {
          try {
            await deletePushToken(token, oldId)
          } catch {
            console.log('[push] old id delete failed, continuing')
          }
        }
        const registration = await registerPushToken(token, {
          token: fcmToken,
          platform: 'android',
          notificationPermission: 'granted',
        })
        await SecureStore.setItemAsync(PUSH_ID_KEY, registration.id)
        console.log('[push] refresh registered')
      } catch (error) {
        console.log(`[push] refresh failed (${error instanceof Error ? error.message : 'unknown'})`)
      }
    })
    return unsubscribe
  }, [token])

  /** Foreground messages: in-app banner (FCM stays silent when foregrounded). */
  useEffect(() => {
    const messaging = getMessaging()
    console.log('[push] listening for foreground messages')
    const unsubscribe = onMessage(messaging, (message: RemoteMessage) => {
      const signalId = parseSignalTap(message.data)
      if (!signalId) {
        console.log('[push] foreground message without signal, ignoring')
        return
      }
      console.log('[push] foreground signal banner')
      setForegroundSignalId(signalId)
    })
    return unsubscribe
  }, [])

  /** Background tap: app was alive in background. */
  useEffect(() => {
    const messaging = getMessaging()
    console.log('[push] listening for background taps')
    const unsubscribe = onNotificationOpenedApp(messaging, (message: RemoteMessage) => {
      const signalId = parseSignalTap(message?.data)
      if (signalId) routeToSignal(signalId, 'background-tap')
    })
    return unsubscribe
  }, [])

  /** Killed-app tap: cold start from notification. */
  useEffect(() => {
    const messaging = getMessaging()
    console.log('[push] checking killed-app tap')
    getInitialNotification(messaging)
      .then((message) => {
        const signalId = parseSignalTap(message?.data)
        if (signalId) routeToSignal(signalId, 'killed-tap')
        else console.log('[push] no killed-app tap')
      })
      .catch(() => console.log('[push] killed-app check failed'))
  }, [])

  const dismissForeground = useCallback(() => {
    console.log('[push] foreground banner dismissed')
    setForegroundSignalId(null)
  }, [])

  const value = useMemo<PushState>(
    () => ({ permission, foregroundSignalId, dismissForeground }),
    [permission, foregroundSignalId, dismissForeground],
  )

  return (
    <Context value={value}>
      {children}
      {foregroundSignalId ? (
        <View style={{ position: 'absolute', top: 60, left: 16, right: 16 }}>
          <Pressable
            accessibilityRole="button"
            style={{ borderRadius: 16, padding: 16 }}
            onPress={() => {
              const id = foregroundSignalId
              dismissForeground()
              routeToSignal(id, 'foreground-banner')
            }}
          >
            <AppText type="defaultSemiBold">Whale alert — tap to view signal</AppText>
          </Pressable>
        </View>
      ) : null}
    </Context>
  )
}
