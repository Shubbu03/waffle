import { useQuery } from '@tanstack/react-query'
import { Link, Stack, useLocalSearchParams } from 'expo-router'
import { RefreshControl, ScrollView } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { getPaperPosition } from '@/lib/paper-api'
import { formatSol, formatTokens } from '@/lib/paper-state'
import { PaperButton, PaperCard, PaperSignIn } from './paper-ui'
import { PaperValue } from './paper-value'
import { usePaperAvailability } from './use-paper'

export function PaperPositionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const positionId = typeof id === 'string' ? id : ''
  const auth = usePaperAvailability()
  const token = auth.session?.accessToken ?? ''
  const ink = useThemeColor({}, 'text')
  const query = useQuery({
    queryKey: [
      'paper',
      auth.session?.userId ?? null,
      AppConfig.apiUrl,
      'position',
      positionId,
      auth.session?.expiresAt,
    ],
    queryFn: ({ signal }) => getPaperPosition(positionId, token, signal),
    enabled: auth.available,
    retry: false,
  })
  const position = query.data
  return (
    <AppView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Simulated position', headerTintColor: ink }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isFetching}
            onRefresh={() => {
              if (auth.available) void query.refetch()
            }}
          />
        }
      >
        {!auth.isAuthenticated ? (
          <PaperSignIn />
        ) : !auth.serverLinked ? (
          <AppText>Reconnect to verify your account.</AppText>
        ) : null}
        {query.isError ? (
          <PaperCard>
            <AppText selectable>{query.error.message}</AppText>
            <PaperButton title="Retry" disabled={!auth.available} onPress={() => void query.refetch()} />
          </PaperCard>
        ) : null}
        {position && auth.isAuthenticated ? (
          <>
            <PaperCard>
              <AppText type="title">Simulated · {position.status}</AppText>
              <AppText selectable>{position.entryQuote.outputMint}</AppText>
              <AppText>Filled: {new Date(position.createdAt).toLocaleString()}</AppText>
              <AppText selectable>
                Held: {formatTokens(position.fill.outputAmountRaw, position.entryQuote.outputDecimals)}
              </AppText>
              <AppText>Size: {formatSol(position.sizeLamports)}</AppText>
              <AppText>Network fees: {formatSol(position.entryQuote.feeLamports)}</AppText>
              <AppText type="defaultSemiBold">Entry cost: {formatSol(position.fill.totalDebitLamports)}</AppText>
              <AppText>
                Entry slippage: {position.entryQuote.slippageBps / 100}% · Impact: {position.entryQuote.priceImpactPct}%
              </AppText>
              <AppText>Entry router fee: {position.entryQuote.fees.totalBps / 100}% (included in output)</AppText>
              <AppText selectable>
                Minimum received: {formatTokens(position.fill.minOutputAmountRaw, position.entryQuote.outputDecimals)}
              </AppText>
              <AppText>Quote age at fill: {position.fill.quoteAgeMs} ms</AppText>
              <Link href={{ pathname: '/signals/[id]', params: { id: position.signalId } }}>
                <AppText type="link">View source signal</AppText>
              </Link>
            </PaperCard>
            <PaperCard>
              <AppText type="subtitle">Current valuation</AppText>
              <PaperValue position={position} automatic />
            </PaperCard>
          </>
        ) : auth.isAuthenticated && query.isPending ? (
          <AppText>Loading position…</AppText>
        ) : null}
        <Link href="/paper/positions">
          <AppText type="link">All paper positions</AppText>
        </Link>
      </ScrollView>
    </AppView>
  )
}
