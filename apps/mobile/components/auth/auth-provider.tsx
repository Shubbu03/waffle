import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { fromUint8Array } from 'js-base64'
import { createContext, type PropsWithChildren, use, useEffect, useMemo, useState } from 'react'
import { ApiError, getSession, postChallenge, postLogout, postVerify } from '@/lib/api-client'
import { isSessionExpired } from '@/lib/session'
import { clearSession, loadSession, type StoredSession, saveSession } from '@/lib/session-store'

export interface AuthState {
  isAuthenticated: boolean
  status: 'loading' | 'signed-in' | 'signed-out'
  session: StoredSession | null
  /** False when signed in wallet-only (server unreachable/verify failed). Demo works; authed API calls wait. */
  serverLinked: boolean
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  isSigningIn: boolean
}

const Context = createContext<AuthState>({} as AuthState)

export function useAuth() {
  const value = use(Context)
  if (!value) {
    throw new Error('useAuth must be wrapped in a <AuthProvider />')
  }
  return value
}

/** Wallet-side cancellation looks different from real failures — say so plainly. */
function toFriendlyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  console.log('[auth] toFriendlyError: classifying failure')
  if (/cancel|dismiss|reject|decline|no wallet|not found/i.test(message)) {
    return new Error('Sign-in cancelled in your wallet — no problem, try again when ready.')
  }
  if (error instanceof ApiError && error.status === 401) {
    return new Error('Sign-in challenge expired — please try again.')
  }
  return error instanceof Error ? error : new Error('Sign-in failed. Please try again.')
}

export function AuthProvider({ children }: PropsWithChildren) {
  const { accounts, disconnect, signIn: walletSignIn } = useMobileWallet()
  const queryClient = useQueryClient()
  const [session, setSession] = useState<StoredSession | null>(null)
  const [status, setStatus] = useState<AuthState['status']>('loading')
  const connectedAddress = accounts?.[0]?.address?.toString() ?? null
  const accountCount = accounts?.length ?? 0

  /** Launch restore: stored session -> expiry check -> server truth. */
  useEffect(() => {
    let cancelled = false
    async function restore(): Promise<void> {
      console.log('[auth] restore: loading stored session')
      const stored = await loadSession()
      if (cancelled) return
      if (!stored) {
        console.log('[auth] restore: empty, signed out')
        setStatus('signed-out')
        return
      }
      if (isSessionExpired(stored.expiresAt)) {
        console.log('[auth] restore: stored session expired, clearing')
        await clearSession()
        if (!cancelled) setStatus('signed-out')
        return
      }
      if (!stored.accessToken) {
        // Wallet-only session: no server to check with, trust it (wallet-change effect still guards).
        console.log('[auth] restore: wallet-only session, skipping server check')
        if (!cancelled) setStatus('signed-in')
        return
      }
      try {
        const live = await getSession(stored.accessToken)
        if (cancelled) return
        console.log('[auth] restore: server confirmed session')
        setSession({ ...stored, expiresAt: live.expiresAt })
        setStatus('signed-in')
      } catch (error) {
        console.log(
          `[auth] restore: server rejected token (${error instanceof ApiError ? error.status : 'network'}), clearing`,
        )
        await clearSession()
        if (!cancelled) setStatus('signed-out')
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  /** Wallet switched accounts mid-session -> old session belongs to someone else. */
  useEffect(() => {
    console.log(
      `[auth] wallet-watch: accounts=${accountCount} connected=${connectedAddress?.slice(0, 8) ?? 'none'}... status=${status}`,
    )
    if (status !== 'signed-in' || !session) return
    if (connectedAddress === null) return // wallet disconnected; session stays until explicit sign-out
    if (connectedAddress !== session.walletAddress) {
      console.log('[auth] wallet-change: connected wallet differs from session, signing out')
      void (async () => {
        try {
          await postLogout(session.accessToken)
        } catch {
          console.log('[auth] wallet-change: server logout failed, clearing locally anyway')
        }
        await clearSession()
        await disconnect()
        queryClient.clear()
        setSession(null)
        setStatus('signed-out')
      })()
    }
  }, [accountCount, connectedAddress, session, status, disconnect, queryClient])

  const signInMutation = useMutation({
    mutationFn: async () => {
      // A live MWA session + a new authorize-in-transact stalls the wallet
      // prompt (builder-verified on device). Start clean when already connected.
      if (connectedAddress) {
        console.log('[auth] signIn: existing wallet session, disconnecting for a clean transact')
        await disconnect()
      }
      // Server challenge carries the nonce. Unreachable server => wallet-only mode.
      console.log('[auth] signIn: requesting challenge')
      let challenge: { challengeId: string; signInInput: Record<string, unknown> } | null = null
      try {
        challenge = (await postChallenge()) as { challengeId: string; signInInput: Record<string, unknown> }
      } catch (error) {
        console.log(
          `[auth] signIn: no challenge (${error instanceof Error ? error.message : 'network'}) — wallet-only mode`,
        )
      }
      const payload = (challenge?.signInInput ?? {}) as {
        domain?: string
        statement?: string
        uri?: string
        version?: string
        chainId?: string
        nonce?: string
        issuedAt?: string
        expirationTime?: string
      }
      console.log(
        `[auth] signIn: wallet payload domain=${payload.domain} uri=${payload.uri} chain=${payload.chainId} nonce=${payload.nonce ? 'present' : 'MISSING'} expiry=${payload.expirationTime ?? 'MISSING'}`,
      )
      console.log('[auth] signIn: asking wallet to sign')
      const walletStart = Date.now()
      const output = await walletSignIn({
        domain: payload.domain,
        statement: payload.statement ?? 'Sign in to waffle. This does not authorize any transactions.',
        uri: payload.uri,
        version: payload.version,
        chainId: payload.chainId,
        nonce: payload.nonce,
        issuedAt: payload.issuedAt,
        expirationTime: payload.expirationTime,
      })
      const accountAddress = output.account.address.toString()
      console.log(
        `[auth] signIn: wallet answered in ${Date.now() - walletStart}ms as ${accountAddress.slice(0, 8)}... ` +
          `msgBytes=${output.signedMessage?.length ?? -1} sigBytes=${output.signature?.length ?? -1}`,
      )
      if (challenge) {
        try {
          const verified = await postVerify({
            challengeId: challenge.challengeId,
            accountAddress,
            signedMessageBase64: fromUint8Array(output.signedMessage),
            signatureBase64: fromUint8Array(output.signature),
          })
          console.log('[auth] signIn: server verified, persisting session')
          const stored: StoredSession = { ...verified.session, accessToken: verified.accessToken }
          await saveSession(stored)
          setSession(stored)
          setStatus('signed-in')
          return
        } catch (error) {
          console.log(
            `[auth] signIn: server verify failed (${error instanceof Error ? error.message : 'network'}) — continuing wallet-only`,
          )
        }
      }
      // Degraded path: wallet proved ownership, server did not countersign.
      // Demo flows work; authed API calls wait for a linked session.
      const weekOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      const local: StoredSession = {
        userId: 'local',
        walletAddress: accountAddress,
        expiresAt: weekOut,
        accessToken: '',
      }
      console.log('[auth] signIn: persisting wallet-only session')
      await saveSession(local)
      setSession(local)
      setStatus('signed-in')
    },
    onError: (error) => {
      console.log('[auth] signIn: failed, staying signed out')
      setStatus(session ? 'signed-in' : 'signed-out')
      throw toFriendlyError(error)
    },
  })

  const value: AuthState = useMemo(
    () => ({
      isAuthenticated: status === 'signed-in' && session !== null,
      status,
      session,
      serverLinked: session !== null && session.accessToken !== '',
      isSigningIn: signInMutation.isPending,
      signIn: async () => {
        await signInMutation.mutateAsync()
      },
      signOut: async () => {
        console.log('[auth] signOut: burning server session best-effort')
        if (session?.accessToken) {
          try {
            await postLogout(session.accessToken)
          } catch {
            console.log('[auth] signOut: server unreachable, clearing locally anyway')
          }
        } else {
          console.log('[auth] signOut: wallet-only session, nothing to burn server-side')
        }
        console.log('[auth] signOut: disconnecting wallet')
        await clearSession()
        await disconnect()
        console.log('[auth] signOut: wallet disconnected, clearing query cache')
        queryClient.clear()
        setSession(null)
        setStatus('signed-out')
        console.log('[auth] signOut: done')
      },
    }),
    [status, session, signInMutation, disconnect, queryClient],
  )

  return <Context value={value}>{children}</Context>
}
