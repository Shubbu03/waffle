/** React Query hooks for issue #22 catalog screen. Thin over lib/*, logs transitions. */

import { useIsFocused } from '@react-navigation/native'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '@/components/auth/auth-provider'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppConfig } from '@/constants/app-config'
import { ApiError } from '@/lib/api-error'
import { mergeCatalog } from '@/lib/wallet-subscription-state'
import {
  followWallet,
  listMyTrackedWallets,
  listSubscriptions,
  listWallets,
  trackWallet,
  unfollowWallet,
  untrackWallet,
  type WalletSubscription,
} from '@/lib/wallets-api'

export function useCatalogWallets() {
  useCluster()
  const focused = useIsFocused()
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => setForeground(state === 'active'))
    return () => listener.remove()
  }, [])
  return useQuery({
    queryKey: ['wallets', AppConfig.apiUrl],
    queryFn: ({ signal }) => listWallets(signal),
    enabled: focused && foreground,
    staleTime: 30_000,
    refetchInterval: focused && foreground ? 30_000 : false,
  })
}

export function useWalletSubscriptions() {
  useCluster()
  const { session, serverLinked } = useAuth()
  const token = session?.accessToken ?? ''
  console.log(`[wallets-hooks] useWalletSubscriptions: ${token ? 'enabled' : 'disabled (signed out)'}`)
  return useQuery({
    queryKey: ['wallet-subscriptions', session?.userId, AppConfig.apiUrl],
    queryFn: ({ signal }): Promise<WalletSubscription[]> => listSubscriptions(token, signal),
    enabled: token !== '' && serverLinked,
    staleTime: 30_000,
  })
}

function useInvalidateSubscriptions() {
  const queryClient = useQueryClient()
  return () => {
    console.log('[wallets-hooks] invalidating subscriptions')
    void queryClient.invalidateQueries({ queryKey: ['wallet-subscriptions'] })
  }
}

export function useFollowWallet() {
  const { session, serverLinked } = useAuth()
  const invalidate = useInvalidateSubscriptions()
  return useMutation({
    mutationFn: async (walletId: string) => {
      if (!session?.accessToken || !serverLinked) throw new Error('Sign in with the API reachable to follow wallets.')
      return followWallet(session.accessToken, walletId)
    },
    onSuccess: (sub) => {
      console.log(`[wallets-hooks] follow ok: ${sub.walletId.slice(0, 8)}...`)
      invalidate()
    },
    onError: (error) => {
      console.log(
        `[wallets-hooks] follow failed: ${error instanceof ApiError ? `${error.status}/${error.code}` : 'network'}`,
      )
    },
  })
}

export function useUnfollowWallet() {
  const { session, serverLinked } = useAuth()
  const invalidate = useInvalidateSubscriptions()
  return useMutation({
    mutationFn: async (walletId: string) => {
      if (!session?.accessToken || !serverLinked) throw new Error('Sign in with the API reachable to change follows.')
      await unfollowWallet(session.accessToken, walletId)
      return walletId
    },
    onSuccess: (walletId) => {
      console.log(`[wallets-hooks] unfollow ok: ${walletId.slice(0, 8)}...`)
      invalidate()
    },
  })
}

export function useAlertToggle() {
  const { session, serverLinked } = useAuth()
  const invalidate = useInvalidateSubscriptions()
  return useMutation({
    mutationFn: async ({ walletId, alertsEnabled }: { walletId: string; alertsEnabled: boolean }) => {
      if (!session?.accessToken || !serverLinked) throw new Error('Sign in with the API reachable to change alerts.')
      return followWallet(session.accessToken, walletId, alertsEnabled)
    },
    onSuccess: (sub) => {
      console.log(`[wallets-hooks] alerts ${sub.alertsEnabled ? 'on' : 'off'}: ${sub.walletId.slice(0, 8)}...`)
      invalidate()
    },
  })
}

/** Wallet IDs this user personally tracks — drives the Custom badge and Untrack. */
export function useMyTrackedWallets() {
  useCluster()
  const { session, serverLinked } = useAuth()
  const token = session?.accessToken ?? ''
  console.log(`[wallets-hooks] useMyTrackedWallets: ${token ? 'enabled' : 'disabled (signed out)'}`)
  return useQuery({
    queryKey: ['wallets-mine', session?.userId, AppConfig.apiUrl],
    queryFn: ({ signal }): Promise<string[]> => listMyTrackedWallets(token, signal),
    enabled: token !== '' && serverLinked,
    staleTime: 30_000,
  })
}

function useInvalidateTracking() {
  const queryClient = useQueryClient()
  return () => {
    console.log('[wallets-hooks] invalidating tracking + catalog')
    void queryClient.invalidateQueries({ queryKey: ['wallets-mine'] })
    void queryClient.invalidateQueries({ queryKey: ['wallet-subscriptions'] })
    void queryClient.invalidateQueries({ queryKey: ['wallets'] })
  }
}

export function useTrackWallet() {
  const { session, serverLinked } = useAuth()
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: async ({ address, label }: { address: string; label?: string }) => {
      if (!session?.accessToken || !serverLinked) throw new Error('Sign in with the API reachable to track wallets.')
      return trackWallet(session.accessToken, address, label)
    },
    onSuccess: (result) => {
      console.log(`[wallets-hooks] track ok: ${result.wallet.id.slice(0, 8)}... created=${result.created}`)
      invalidate()
    },
    onError: (error) => {
      console.log(
        `[wallets-hooks] track failed: ${error instanceof ApiError ? `${error.status}/${error.code}` : 'network'}`,
      )
    },
  })
}

export function useUntrackWallet() {
  const { session, serverLinked } = useAuth()
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: async (walletId: string) => {
      if (!session?.accessToken || !serverLinked) throw new Error('Sign in with the API reachable to untrack wallets.')
      return untrackWallet(session.accessToken, walletId)
    },
    onSuccess: (result, walletId) => {
      console.log(`[wallets-hooks] untrack ok: ${walletId.slice(0, 8)}... paused=${result.paused}`)
      invalidate()
    },
  })
}

/** Rows for the screen: public catalog joined with the owner's follows and tracked wallets. */
export function useWalletRows() {
  const catalog = useCatalogWallets()
  const subscriptions = useWalletSubscriptions()
  const mine = useMyTrackedWallets()
  const rows = catalog.data ? mergeCatalog(catalog.data, subscriptions.data ?? [], mine.data ?? []) : []
  return { rows, catalog, subscriptions, mine }
}
