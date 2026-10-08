import { useIsFocused } from '@react-navigation/native'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '@/components/auth/auth-provider'
import { useCluster } from '@/components/cluster/cluster-provider'
import { useCatalogWallets, useWalletSubscriptions } from '@/components/wallets/use-wallets'
import { reportUnauthorized } from '@/lib/api-client'
import { feedCacheKey } from '@/lib/signal-cache'
import { type LiveSocket, SignalFeed } from '@/lib/signal-feed'
import type { SignalView } from '@/lib/signal-state'
import { loadDetail, loadFeed, saveDetail, saveFeed } from '@/lib/signal-storage'
import { getSignal, listSignals } from '@/lib/signals-api'

export function useSignalFeed(view: SignalView, walletId?: string) {
  const { apiUrl: origin } = useCluster()
  const { session, serverLinked } = useAuth()
  const subscriptions = useWalletSubscriptions()
  const catalog = useCatalogWallets()
  const focused = useIsFocused()
  const owner = session?.userId ?? null
  const token = session?.accessToken
  const subscriptionKey =
    view === 'following' && subscriptions.isSuccess
      ? JSON.stringify(subscriptions.data.map((item) => item.walletId).sort())
      : null
  const networkEnabled = view === 'all' || (serverLinked && subscriptions.isSuccess)
  const controller = useMemo(() => {
    const key = view === 'following' && !owner ? null : feedCacheKey(origin, view, owner, walletId)
    return new SignalFeed({
      view,
      walletId,
      token,
      subscriptionKey,
      networkEnabled: networkEnabled && key !== null,
      load: async () => {
        if (!key) return null
        const cached = await loadFeed(key)
        if (cached || !walletId) return cached
        // Preserve already-saved browsing when opening a wallet offline for the first time.
        const shared = await loadFeed(feedCacheKey(origin, view, owner))
        return shared ? { ...shared, items: shared.items.filter((item) => item.walletId === walletId) } : null
      },
      save: (cache) => (key ? saveFeed(key, cache) : Promise.resolve()),
      list: (cursor, signal) => listSignals({ view, walletId, cursor }, token, signal),
      detail: async (id, signal) => {
        const detail = await getSignal(id, signal)
        await saveDetail({ signal: detail, fetchedAt: Date.now() }, origin).catch(() => {})
        return detail
      },
      socket: () => {
        const url = new URL(`${origin}/live`)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const native = new WebSocket(url.href)
        const socket: LiveSocket = {
          send: (message) => native.send(message),
          close: () => native.close(),
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        }
        native.onopen = () => socket.onopen?.()
        native.onmessage = (event) => socket.onmessage?.({ data: event.data })
        native.onclose = () => socket.onclose?.()
        native.onerror = () => socket.onerror?.()
        return socket
      },
      unauthorized: () => {
        if (token) reportUnauthorized(token)
      },
    })
  }, [view, walletId, token, owner, subscriptionKey, networkEnabled, origin])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    if (!focused) return
    if (AppState.currentState === 'active') void controller.start()
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') void controller.start()
      else controller.stop()
    })
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') void controller.refresh()
    }, 30_000)
    return () => {
      listener.remove()
      clearInterval(interval)
      controller.stop()
    }
  }, [focused, controller])
  return {
    ...state,
    catalog: catalog.data ?? [],
    catalogLoading: catalog.isPending,
    catalogError: catalog.isError,
    subscribedWalletIds: subscriptions.data?.map((item) => item.walletId) ?? null,
    subscriptionsLoading: serverLinked && subscriptions.isPending,
    refresh: async () => {
      await Promise.allSettled([
        controller.refresh(),
        catalog.refetch(),
        ...(view === 'following' && serverLinked ? [subscriptions.refetch()] : []),
      ])
    },
    loadMore: () => controller.loadMore(),
    followingError:
      view === 'following' && subscriptions.isError ? 'Unable to load followed wallets. Pull down to retry.' : null,
    waitingForSession: view === 'following' && !serverLinked,
  }
}

export function useSignalDetail(id: string) {
  const client = useQueryClient()
  const focused = useIsFocused()
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const { apiUrl: origin } = useCluster()
  const key = useMemo(() => ['signal-detail', origin, id], [id, origin])
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const detail = await getSignal(id, signal)
      const data = { signal: detail, fetchedAt: Date.now(), fromCache: false }
      await saveDetail(data, origin).catch(() => {})
      return data
    },
    enabled: focused && foreground,
    retry: false,
    refetchInterval: 30_000,
    staleTime: 0,
  })
  useEffect(() => {
    let cancelled = false
    void loadDetail(id, origin)
      .then((cached) => {
        if (!cancelled && cached && !client.getQueryData(key)) {
          client.setQueryData(key, { ...cached, fromCache: true })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, client, key, origin])
  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => {
      setForeground(next === 'active')
      if (next === 'active') void client.invalidateQueries({ queryKey: key })
    })
    return () => listener.remove()
  }, [client, key])
  return query
}

export function useSignalClock() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}
