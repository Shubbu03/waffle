import { useIsFocused } from '@react-navigation/native'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '@/components/auth/auth-provider'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppConfig } from '@/constants/app-config'
import { ApiError } from '@/lib/api-error'
import { createPaperPosition, lookupPaperPosition, preparePaperQuote } from '@/lib/paper-api'
import { PaperTradeController } from '@/lib/paper-state'
import { paperPendingStore } from '@/lib/paper-storage'

export function usePaperAvailability() {
  useCluster()
  const auth = useAuth()
  const focused = useIsFocused()
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => setForeground(next === 'active'))
    return () => listener.remove()
  }, [])
  return { ...auth, available: auth.serverLinked && auth.session !== null && foreground && focused }
}
export function usePaperTrade(signalId: string, blocked: string | null) {
  const auth = usePaperAvailability()
  const { apiUrl: origin } = useCluster()
  const current = useRef({ available: false, blocked, token: auth.session?.accessToken })
  current.current = { available: auth.available, blocked, token: auth.session?.accessToken }
  const token = auth.session?.accessToken
  const owner = auth.session?.userId
  const controller = useMemo(() => {
    const assertSession = () => {
      if (
        AppConfig.apiUrl !== origin ||
        !token ||
        current.current.token !== token ||
        !current.current.available ||
        AppState.currentState !== 'active'
      )
        throw new Error('Sign in before continuing.')
    }
    const assertTrade = () => {
      assertSession()
      if (current.current.blocked) throw new Error(current.current.blocked)
    }
    const store = owner
      ? paperPendingStore(origin, owner, signalId)
      : {
          load: async () => null,
          save: async () => {
            throw new Error('Sign in first.')
          },
          clear: async () => {},
        }
    return new PaperTradeController(signalId, {
      ...store,
      canSubmit: () =>
        AppConfig.apiUrl === origin &&
        current.current.token === token &&
        current.current.available &&
        current.current.blocked === null &&
        AppState.currentState === 'active',
      prepare: async (sizeLamports, signal) => {
        assertTrade()
        return preparePaperQuote({ signalId, sizeLamports }, token ?? '', signal)
      },
      create: async (pending) => {
        // A local refusal before POST is a definitive non-submission.
        try {
          assertTrade()
        } catch (error) {
          throw new ApiError(409, 'REVIEW_CHANGED', error instanceof Error ? error.message : 'Review changed.')
        }
        return createPaperPosition(pending, token ?? '')
      },
      lookup: (quoteId) => {
        assertSession()
        return lookupPaperPosition(quoteId, token ?? '')
      },
    })
  }, [signalId, token, owner, origin])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    if (auth.available) void controller.restore()
    return () => controller.invalidate()
  }, [controller, auth.available])
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') controller.invalidate()
    })
    return () => listener.remove()
  }, [controller])
  useEffect(() => {
    if (blocked) controller.invalidate()
  }, [controller, blocked])
  return { ...state, ...auth, controller }
}
