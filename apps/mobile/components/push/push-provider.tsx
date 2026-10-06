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
  registrationUnavailable: boolean
  isRegistering: boolean
  retryRegistration: () => void
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
  const [isRegistering, setIsRegistering] = useState(false)
  const retryRegistrationRef = useRef<(() => void) | null>(null)
  const [foreground, setForeground] = useState<SignalPush | null>(null)
  const [pendingTap, setPendingTap] = useState<PushTap | null>(null)
  const lastTap = useRef({ id: '', at: 0 })
  const background = useThemeColor({}, 'background')
  const text = useThemeColor({}, 'text')

  useEffect(() => {
    setForeground(null)
    setRegistrationUnavailable(false)
    setIsRegistering(false)
    if (Platform.OS !== 'android' || !accessToken) return
    const owner = sessionRef.current
    if (!owner) return
    pushDevice.activate(owner)
    let cancelled = false
    let pending = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const clearRetry = () => {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    const synchronize = (request = false) => {
      if (cancelled || pending) return
      clearRetry()
      pending = true
      setIsRegistering(true)
      let failed = false
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
          failed = true
          if (!cancelled) {
            setRegistrationUnavailable(true)
            return readPushPermission()
              .then((value) => {
                if (!cancelled) setPermission(value)
              })
              .catch(() => console.warn('[push] permission unavailable'))
          }
        })
        .finally(() => {
          pending = false
          if (cancelled) return
          setIsRegistering(false)
          if (failed && AppState.currentState === 'active') {
            retryTimer = setTimeout(() => synchronize(), 30_000)
          }
        })
    }
    retryRegistrationRef.current = synchronize
    setPermission('checking')
    synchronize(true)
    const unsubscribeRefresh = onTokenRefresh(getMessaging(), () => synchronize())
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') synchronize()
      else clearRetry()
    })
    return () => {
      cancelled = true
      clearRetry()
      retryRegistrationRef.current = null
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
  const retryRegistration = useCallback(() => retryRegistrationRef.current?.(), [])
  const value = useMemo<PushState>(
    () => ({
      permission,
      registrationUnavailable,
      isRegistering,
      retryRegistration,
      foregroundSignalId: foreground?.id ?? null,
      dismissForeground,
    }),
    [permission, registrationUnavailable, isRegistering, retryRegistration, foreground, dismissForeground],
  )

  return (
    <Context value={value}>
      {children}
      {session && Platform.OS === 'android' && foreground ? (
        <View style={{ position: 'absolute', top: 60, left: 16, right: 16, gap: 8 }}>
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
