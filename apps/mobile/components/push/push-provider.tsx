import notifee, { EventType } from '@notifee/react-native'
import { getMessaging, onMessage, onTokenRefresh } from '@react-native-firebase/messaging'
import { useQueryClient } from '@tanstack/react-query'
import { router, useRootNavigationState } from 'expo-router'
import { createContext, type PropsWithChildren, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Platform, Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { pushDevice, readPushPermission } from '@/lib/push-device'
import {
  clearPendingPushTap,
  onPushTap,
  type PushTap,
  queuePushTap,
  readPendingPushTap,
  receivePush,
} from '@/lib/push-notifications'
import type { PushPermission, SignalPush } from '@/lib/push-tap'

export interface PushState {
  permission: PushPermission | 'checking'
  foregroundSignalId: string | null
  dismissForeground: () => void
}

const Context = createContext<PushState | null>(null)
export function usePush() {
  const value = use(Context)
  if (!value) throw new Error('usePush must be wrapped in <PushProvider />')
  return value
}

export function PushProvider({ children }: PropsWithChildren) {
  const { session, status } = useAuth()
  const accessToken = session?.accessToken
  const sessionRef = useRef(session)
  sessionRef.current = session
  const navigation = useRootNavigationState()
  const client = useQueryClient()
  const [permission, setPermission] = useState<PushState['permission']>('checking')
  const [registrationUnavailable, setRegistrationUnavailable] = useState(false)
  const [foreground, setForeground] = useState<SignalPush | null>(null)
  const [pendingTap, setPendingTap] = useState<PushTap | null>(null)
  const lastTap = useRef({ id: '', at: 0 })
  const background = useThemeColor({}, 'background')
  const text = useThemeColor({}, 'text')

  useEffect(() => {
    setForeground(null)
    setRegistrationUnavailable(false)
    if (Platform.OS !== 'android' || !accessToken) return
    const owner = sessionRef.current
    if (!owner) return
    pushDevice.activate(owner)
    let cancelled = false
    const synchronize = (request = false) => {
      void pushDevice
        .synchronize(owner, request)
        .then((value) => {
          if (!cancelled && value) {
            setPermission(value)
            setRegistrationUnavailable(false)
            if (value === 'denied') setForeground(null)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRegistrationUnavailable(true)
            void readPushPermission()
              .then((value) => {
                if (!cancelled) setPermission(value)
              })
              .catch(() => {
                if (!cancelled) setPermission('denied')
              })
          }
          console.warn('[push] registration unavailable')
        })
    }
    setPermission('checking')
    synchronize(true)
    const unsubscribeRefresh = onTokenRefresh(getMessaging(), () => synchronize())
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') synchronize()
    })
    return () => {
      cancelled = true
      unsubscribeRefresh()
      listener.remove()
    }
  }, [accessToken])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    return onMessage(getMessaging(), (message) => {
      const owner = sessionRef.current?.userId
      void receivePush(message.data, (_signal, push) => {
        if (owner && sessionRef.current?.userId === owner && pushDevice.canDeliver(owner)) setForeground(push)
      }).catch(() => console.warn('[push] foreground delivery unavailable'))
    })
  }, [])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    let cancelled = false
    const loadTap = () => {
      void readPendingPushTap()
        .then((tap) => {
          if (!cancelled && tap) setPendingTap(tap)
        })
        .catch(() => console.warn('[push] pending tap unavailable'))
    }
    const unsubscribeTap = onPushTap(setPendingTap)
    const unsubscribeEvents = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.PRESS)
        void queuePushTap(detail.notification?.data).catch(() => console.warn('[push] tap unavailable'))
    })
    void notifee
      .getInitialNotification()
      .then((initial) => {
        if (!cancelled && initial) return queuePushTap(initial.notification.data)
      })
      .catch(() => console.warn('[push] initial notification unavailable'))
    loadTap()
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') loadTap()
    })
    return () => {
      cancelled = true
      unsubscribeTap()
      unsubscribeEvents()
      listener.remove()
    }
  }, [])

  const openSignal = useCallback(
    (id: string) => {
      void client.invalidateQueries({ queryKey: ['signal-detail', AppConfig.apiUrl, id] })
      router.push({ pathname: '/signals/[id]', params: { id } })
    },
    [client],
  )

  useEffect(() => {
    if (!pendingTap || !navigation?.key || status === 'loading') return
    setPendingTap(null)
    void clearPendingPushTap().catch(() => console.warn('[push] tap cleanup unavailable'))
    if (session?.userId && session.userId !== pendingTap.userId) return
    const now = Date.now()
    if (lastTap.current.id === pendingTap.id && now - lastTap.current.at < 2000) return
    lastTap.current = { id: pendingTap.id, at: now }
    openSignal(pendingTap.id)
  }, [pendingTap, navigation?.key, status, session?.userId, openSignal])

  useEffect(() => {
    if (!foreground) return
    const timer = setTimeout(() => setForeground(null), Math.max(0, foreground.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [foreground])

  const dismissForeground = useCallback(() => setForeground(null), [])
  const value = useMemo<PushState>(
    () => ({
      permission,
      foregroundSignalId: foreground?.id ?? null,
      dismissForeground,
    }),
    [permission, foreground, dismissForeground],
  )

  return (
    <Context value={value}>
      {children}
      {session && Platform.OS === 'android' && (foreground || permission === 'denied' || registrationUnavailable) ? (
        <View style={{ position: 'absolute', top: 60, left: 16, right: 16, gap: 8 }}>
          {permission === 'denied' || registrationUnavailable ? (
            <View
              accessibilityRole="alert"
              style={{ backgroundColor: background, borderColor: text, borderWidth: 1, borderRadius: 16, padding: 16 }}
            >
              <AppText>
                {permission === 'denied'
                  ? 'Alerts are off. Enable notifications in Android Settings and reopen the app.'
                  : 'Alerts are unavailable. Check your connection and reopen the app to retry.'}
              </AppText>
            </View>
          ) : null}
          {foreground ? (
            <View
              style={{
                backgroundColor: background,
                borderColor: text,
                borderWidth: 1,
                borderRadius: 16,
                padding: 16,
                gap: 8,
              }}
            >
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  dismissForeground()
                  openSignal(foreground.id)
                }}
              >
                <AppText type="defaultSemiBold">Whale alert — tap to view signal</AppText>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={dismissForeground}>
                <AppText>Dismiss</AppText>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </Context>
  )
}
