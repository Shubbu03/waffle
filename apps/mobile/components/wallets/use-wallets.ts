/** React Query hooks for issue #22 catalog screen. Thin over lib/*, logs transitions. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/components/auth/auth-provider'
import { ApiError } from '@/lib/api-error'
import { mergeCatalog } from '@/lib/wallet-subscription-state'
import {
  followWallet,
  listSubscriptions,
  listWallets,
  unfollowWallet,
  type WalletSubscription,
} from '@/lib/wallets-api'

export function useCatalogWallets() {
  console.log('[wallets-hooks] useCatalogWallets: subscribing')
  return useQuery({ queryKey: ['wallets'], queryFn: listWallets, staleTime: 60_000 })
}

export function useWalletSubscriptions() {
  const { session, serverLinked } = useAuth()
  const token = session?.accessToken ?? ''
  console.log(`[wallets-hooks] useWalletSubscriptions: ${token ? 'enabled' : 'disabled (signed out)'}`)
  return useQuery({
    queryKey: ['wallet-subscriptions', session?.userId],
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

/** Rows for the screen: public catalog joined with the owner's follows. */
export function useWalletRows() {
  const catalog = useCatalogWallets()
  const subscriptions = useWalletSubscriptions()
  const rows = catalog.data ? mergeCatalog(catalog.data, subscriptions.data ?? []) : []
  return { rows, catalog, subscriptions }
}
