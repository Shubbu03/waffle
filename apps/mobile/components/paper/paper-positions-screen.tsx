import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, Stack } from 'expo-router'
import { RefreshControl, ScrollView, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { listPaperPositions } from '@/lib/paper-api'
import { formatSol, formatTokens } from '@/lib/paper-state'
import { PaperButton, PaperCard, PaperSignIn } from './paper-ui'
import { PaperValue } from './paper-value'
import { usePaperAvailability } from './use-paper'

export function PaperPositionsScreen() {
  const auth = usePaperAvailability()
  const ink = useThemeColor({}, 'text')
  const token = auth.session?.accessToken ?? ''
  const query = useInfiniteQuery({
    queryKey: ['paper', auth.session?.userId ?? null, AppConfig.apiUrl, 'positions', auth.session?.expiresAt],
    queryFn: ({ pageParam, signal }) => listPaperPositions(token, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: auth.available,
    retry: false,
  })
  const positions = [
    ...new Map(query.data?.pages.flatMap((page) => page.items).map((position) => [position.id, position])).values(),
  ]
  return (
    <AppView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Paper positions', headerTintColor: ink }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 18 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => {
              if (auth.available) void query.refetch()
            }}
          />
        }
      >
        <View style={{ gap: 8 }}>
          <AppText type="title">Paper positions</AppText>
          <AppText>
            SIMULATED · Entry costs include network fees. Refresh values for a fresh indicative exit quote.
          </AppText>
        </View>
        {!auth.isAuthenticated ? (
          <PaperSignIn />
        ) : !auth.serverLinked ? (
          <AppText>Reconnect to verify your account and refresh positions.</AppText>
        ) : null}
        {auth.isAuthenticated && query.isPending ? <AppText>Loading positions…</AppText> : null}
        {query.isError ? (
          <PaperCard>
            <AppText selectable>Refresh failed: {query.error.message}</AppText>
            <PaperButton title="Retry" disabled={!auth.available} onPress={() => void query.refetch()} />
          </PaperCard>
        ) : null}
        {query.isSuccess && !positions.length ? (
          <PaperCard>
            <AppText type="subtitle">No simulated fills yet</AppText>
            <AppText>Open a fresh eligible signal and review a paper copy to add your first position.</AppText>
            <Link href="/(tabs)">
              <AppText type="link">Browse signals</AppText>
            </Link>
          </PaperCard>
        ) : null}
        {auth.isAuthenticated
          ? positions.map((position) => (
              <PaperCard key={position.id}>
                <Link href={{ pathname: '/paper/positions/[id]', params: { id: position.id } }}>
                  <AppText type="subtitle">Simulated · {position.status}</AppText>
                </Link>
                <AppText selectable>{position.entryQuote.outputMint}</AppText>
                <AppText selectable>
                  {formatTokens(position.fill.outputAmountRaw, position.entryQuote.outputDecimals)}
                </AppText>
                <AppText>Entry cost: {formatSol(position.fill.totalDebitLamports)}</AppText>
                <AppText>Filled: {new Date(position.createdAt).toLocaleString()}</AppText>
                <AppText>Entry network fees: {formatSol(position.entryQuote.feeLamports)}</AppText>
                <PaperValue position={position} automatic={false} />
              </PaperCard>
            ))
          : null}
        {query.hasNextPage ? (
          <PaperButton
            title={query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            disabled={!auth.available || query.isFetching}
            onPress={() => void query.fetchNextPage()}
          />
        ) : null}
      </ScrollView>
    </AppView>
  )
}
