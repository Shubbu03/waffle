import { useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { createContext, type PropsWithChildren, use, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppConfig } from '@/constants/app-config'
import { ApiError, apiBaseUrl, getSession, onUnauthorized, postLogout, postVerify } from '@/lib/api-client'
import { toWireBase64 } from '@/lib/b64'
import { WALLET_SIGN_TIMEOUT_MS, withTransactTimeout } from '@/lib/mwa-transact'
import { SessionController, type SessionState } from '@/lib/session-controller'
import { clearSession, loadSession, saveSession } from '@/lib/session-store'
import { buildSignInInput } from '@/lib/sign-in-input'

type AuthState = SessionState & { isAuthenticated: boolean; signIn: () => Promise<void>; signOut: () => Promise<void> }
const Context = createContext<AuthState | null>(null)
export function useAuth() {
  const value = use(Context)
  if (!value) throw new Error('useAuth must be wrapped in an AuthProvider')
  return value
}
export function AuthProvider({ children }: PropsWithChildren) {
  const { account, disconnect, signIn: walletSignIn } = useMobileWallet()
  const { selectedCluster } = useCluster()
  const queryClient = useQueryClient()
  const [controller] = useState(
    () =>
      new SessionController({
        load: loadSession,
        save: saveSession,
        clear: clearSession,
        verify: getSession,
        revoke: postLogout,
      }),
  )
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const previousOwner = useRef<string | null>(null)
  const connectedAddress = account?.address.toString() ?? null
  useEffect(() => {
    void controller.restore()
    return onUnauthorized((token) => {
      void controller.invalidate(token).catch(() => {})
    })
  }, [controller])
  useEffect(() => {
    const owner = state.session?.userId ?? null
    if (previousOwner.current !== owner) {
      if (previousOwner.current) {
        const queryKey = ['wallet-subscriptions', previousOwner.current]
        void queryClient.cancelQueries({ queryKey })
        queryClient.removeQueries({ queryKey })
        const paperKey = ['paper', previousOwner.current]
        void queryClient.cancelQueries({ queryKey: paperKey })
        queryClient.removeQueries({ queryKey: paperKey })
      }
      previousOwner.current = owner
    }
  }, [state.session?.userId, queryClient])
  useEffect(() => {
    if (!state.session || state.isSigningIn) return
    if (
      (connectedAddress && connectedAddress !== state.session.walletAddress) ||
      selectedCluster.id !== 'solana:mainnet'
    ) {
      void controller.signOut().catch(() => {})
    }
  }, [connectedAddress, selectedCluster.id, state.session, state.isSigningIn, controller])
  useEffect(() => {
    if (!state.session) return
    const expire = () => {
      void controller.signOut().catch(() => {})
    }
    const timer = setTimeout(expire, Math.max(0, Date.parse(state.session.expiresAt) - Date.now()))
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') void controller.refresh()
    })
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') void controller.refresh()
    }, 30_000)
    return () => {
      clearTimeout(timer)
      clearInterval(interval)
      listener.remove()
    }
  }, [state.session, controller])
  const signIn = async () => {
    try {
      await controller.signIn(async () => {
        if (!AppConfig.uri) throw new Error('Configure the public HTTPS app URL before signing in.')
        apiBaseUrl()
        if (selectedCluster.id !== 'solana:mainnet') throw new Error('Switch to Mainnet in Settings to sign in.')
        const askWallet = () => walletSignIn(buildSignInInput(AppConfig.uri))
        let output: Awaited<ReturnType<typeof walletSignIn>>
        try {
          output = await withTransactTimeout('wallet-sign', WALLET_SIGN_TIMEOUT_MS, askWallet)
        } catch (error) {
          // Rejection is final; only a stalled transport gets one fresh attempt.
          if (!(error instanceof Error) || !error.message.includes('timed out')) throw error
          await disconnect()
          output = await withTransactTimeout('wallet-sign-retry', WALLET_SIGN_TIMEOUT_MS, askWallet)
        }
        const verified = await postVerify({
          accountAddress: output.account.address.toString(),
          signedMessageBase64: toWireBase64(output.signedMessage, 'msg'),
          signatureBase64: toWireBase64(output.signature, 'sig'),
        })
        return { ...verified.session, accessToken: verified.accessToken }
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        throw new Error('Wallet verification failed or expired. Try again.')
      if (error instanceof Error && /cancel|dismiss|reject|decline/i.test(error.message)) {
        throw new Error('Sign-in cancelled in your wallet.')
      }
      throw error
    }
  }
  const signOut = async () => {
    try {
      await controller.signOut()
    } finally {
      await disconnect()
    }
  }
  return <Context value={{ ...state, isAuthenticated: state.session !== null, signIn, signOut }}>{children}</Context>
}
