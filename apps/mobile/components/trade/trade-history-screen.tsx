import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Stack } from 'expo-router'
import { RefreshControl, ScrollView } from 'react-native'
import { AppExternalLink } from '@/components/app-external-link'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useCluster } from '@/components/cluster/cluster-provider'
import { usePaperAvailability } from '@/components/paper/use-paper'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { getTradeAttempt, listTradeAttempts } from '@/lib/trade-api'
import { TradeReceipt } from './trade-receipt'

export function TradeHistoryScreen() {
  const auth = usePaperAvailability()
  const { apiUrl, getExplorerUrl } = useCluster()
  const token = auth.session?.accessToken ?? ''
  const client = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: ['trades', apiUrl, auth.session?.userId, auth.session?.expiresAt],
    queryFn: async ({ pageParam, signal }) => {
      const page = await listTradeAttempts(token, pageParam, signal)
      // Resolve every visible pending record, rather than starving older attempts behind newer reviews.
      for (let i = 0; i < page.items.length; i++) {
        const item = page.items[i]
        if (item.status === 'submitted') page.items[i] = await getTradeAttempt(token, item.id)
      }
      return page
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: auth.available,
    retry: false,
    refetchInterval: (state) =>
      auth.available &&
      state.state.data?.pages.some((p) => p.items.some((t) => t.status === 'submitted' || t.status === 'prepared'))
        ? 5000
        : false,
  })
  const attempts = [...new Map(query.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item])).values()]
  async function refresh() {
    await query.refetch()
    await Promise.all([
      client.invalidateQueries({ queryKey: ['get-balance'] }),
      client.invalidateQueries({ queryKey: ['get-token-accounts'] }),
    ])
  }
  return (
    <AppView style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Trade history', headerShown: true }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => {
              if (auth.available) void refresh()
            }}
          />
        }
      >
        <AppText type="title">Your purchases</AppText>
        <AppText>Each purchase requires wallet approval. Checking a pending purchase never submits it again.</AppText>
        {!auth.isAuthenticated ? (
          <Link href="/sign-in">
            <AppText type="link">Sign in with wallet</AppText>
          </Link>
        ) : null}
        {auth.isAuthenticated && !auth.available ? (
          <AppText>Reconnect your account to refresh trade history.</AppText>
        ) : null}
        {query.isPending && auth.available ? <AppText>Loading purchases…</AppText> : null}
        {query.isError ? (
          <AppCard>
            <AppText selectable>{query.error.message}</AppText>
            <AppButton title="Retry" disabled={!auth.available} onPress={() => void refresh()} />
          </AppCard>
        ) : null}
        {query.isSuccess && !attempts.length ? (
          <AppCard>
            <AppText>No purchases yet. Open a signal to review your first trade.</AppText>
          </AppCard>
        ) : null}
        {auth.isAuthenticated
          ? attempts.map((attempt) => (
              <AppCard key={attempt.id}>
                <AppText type="subtitle">
                  {
                    {
                      prepared: 'Review prepared',
                      submitted: 'Checking purchase',
                      confirmed: 'Purchase confirmed',
                      failed: 'Purchase failed',
                      expired: 'Review or transaction expired',
                      wallet_rejected: 'Approval cancelled',
                    }[attempt.status]
                  }
                </AppText>
                <AppText>{new Date(attempt.createdAt).toLocaleString()}</AppText>
                <TradeReceipt attempt={attempt} />
                {attempt.failureReason ? <AppText selectable>{attempt.failureReason}</AppText> : null}
                {attempt.signature ? (
                  <AppExternalLink href={getExplorerUrl(`tx/${attempt.signature}`)}>
                    <AppText type="link">View transaction</AppText>
                  </AppExternalLink>
                ) : null}
                <Link href={{ pathname: '/signals/[id]', params: { id: attempt.signalId } }}>
                  <AppText type="link">View source signal</AppText>
                </Link>
              </AppCard>
            ))
          : null}
        {query.hasNextPage ? (
          <AppButton
            title="Load more"
            busy={query.isFetchingNextPage}
            disabled={!auth.available || query.isFetching}
            onPress={() => void query.fetchNextPage()}
          />
        ) : null}
      </ScrollView>
    </AppView>
  )
}
