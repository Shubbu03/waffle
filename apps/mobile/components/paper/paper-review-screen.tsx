import { Link, Stack, useLocalSearchParams } from 'expo-router'
import { RefreshControl, ScrollView, TextInput, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useSignalClock, useSignalDetail } from '@/components/signals/use-signals'
import { useThemeColor } from '@/hooks/use-theme-color'
import { formatSol, formatTokens, paperQuoteFresh, paperReviewBlock, parsePaperSize } from '@/lib/paper-state'
import { PaperButton, PaperCard, PaperSignIn } from './paper-ui'
import { usePaperTrade } from './use-paper'

export function PaperReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const signalId = typeof id === 'string' ? id : ''
  const detail = useSignalDetail(signalId)
  const now = useSignalClock()
  const ink = useThemeColor({}, 'text')
  const blocked = paperReviewBlock(
    detail.data?.signal,
    detail.isError || !detail.data || detail.data.fromCache || now - detail.data.fetchedAt > 45_000,
    now,
  )
  const trade = usePaperTrade(signalId, blocked)
  const quote = trade.quote
  const fresh = quote && paperQuoteFresh(quote, now)
  const unavailable = !trade.available || !!blocked || trade.busy || !trade.ready || !!trade.pending || !!trade.position
  return (
    <AppView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Review paper copy', headerTintColor: ink }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={detail.isFetching}
            onRefresh={() => {
              trade.controller.invalidate()
              void detail.refetch()
            }}
          />
        }
      >
        <View style={{ gap: 8 }}>
          <AppText type="title">Paper copy</AppText>
          <AppText type="defaultSemiBold">SIMULATED · No wallet transaction</AppText>
          <AppText>Review a fresh quote before recording a simulated fill.</AppText>
          <AppText selectable>{detail.data?.signal.mintAddress ?? 'Loading signal…'}</AppText>
        </View>
        {!trade.isAuthenticated ? (
          <PaperSignIn />
        ) : !trade.serverLinked ? (
          <AppText>Verifying your session. Reconnect before trading.</AppText>
        ) : null}
        {blocked && !trade.position && !trade.pending ? (
          <PaperCard>
            <AppText>{blocked}</AppText>
            <AppText>
              Refresh updates the saved evidence; a new quote alone does not renew token or pool checks.
            </AppText>
          </PaperCard>
        ) : null}
        {trade.position ? (
          <PaperCard>
            <AppText type="subtitle">Simulated fill recorded</AppText>
            <AppText selectable>Entry cost: {formatSol(trade.position.fill.totalDebitLamports)}</AppText>
            <AppText>{new Date(trade.position.createdAt).toLocaleString()}</AppText>
            <Link href={{ pathname: '/paper/positions/[id]', params: { id: trade.position.id } }}>
              <AppText type="link">View position</AppText>
            </Link>
            <Link href="/paper/positions">
              <AppText type="link">All paper positions</AppText>
            </Link>
          </PaperCard>
        ) : (
          <>
            <PaperCard>
              <AppText type="subtitle">Size in SOL</AppText>
              <AppText>Maximum 0.1 SOL per paper fill.</AppText>
              <TextInput
                accessibilityLabel="Paper size in SOL"
                value={trade.size}
                onChangeText={(size) => trade.controller.setSize(size)}
                editable={!trade.busy && !trade.pending}
                keyboardType="decimal-pad"
                placeholder="0.1"
                placeholderTextColor={ink}
                style={{ color: ink, borderColor: ink, borderWidth: 1, padding: 14, borderRadius: 12, fontSize: 22 }}
              />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {['0.01', '0.05', '0.1'].map((size) => (
                  <View key={size} style={{ flex: 1 }}>
                    <PaperButton
                      title={size}
                      disabled={trade.busy || !!trade.pending}
                      onPress={() => trade.controller.setSize(size)}
                    />
                  </View>
                ))}
              </View>
              <PaperButton
                title={trade.busy && !trade.pending ? 'Working…' : 'Get fresh quote'}
                disabled={unavailable || !parsePaperSize(trade.size)}
                onPress={() => void trade.controller.prepare()}
              />
            </PaperCard>
            {quote ? (
              <PaperCard>
                <AppText type="subtitle">Quote review</AppText>
                <AppText>
                  {fresh
                    ? `Expires in ${Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000))}s`
                    : 'Expired · request a fresh quote'}
                </AppText>
                <AppText selectable>Expected: {formatTokens(quote.outputAmountRaw, quote.outputDecimals)}</AppText>
                <AppText selectable>
                  Minimum received: {formatTokens(quote.minOutputAmountRaw, quote.outputDecimals)}
                </AppText>
                <AppText>
                  Slippage: {quote.slippageBps / 100}% · Price impact: {quote.priceImpactPct}%
                </AppText>
                <AppText>Signature fee: {formatSol(quote.fees.signatureLamports)}</AppText>
                <AppText>Priority fee: {formatSol(quote.fees.prioritizationLamports)}</AppText>
                <AppText>Rent: {formatSol(quote.fees.rentLamports)}</AppText>
                <AppText>Router fee: {quote.fees.totalBps / 100}% (included in output)</AppText>
                {quote.fees.platform ? (
                  <AppText selectable>
                    Platform fee: {quote.fees.platform.amountRaw} base units · mint {quote.fees.platform.mint} (included
                    in output)
                  </AppText>
                ) : null}
                <AppText type="defaultSemiBold">
                  Total entry cost:{' '}
                  {formatSol((BigInt(quote.inputAmountLamports) + BigInt(quote.feeLamports)).toString())}
                </AppText>
                <PaperButton
                  title="Confirm simulated fill"
                  disabled={unavailable || !fresh}
                  onPress={() => void trade.controller.confirm()}
                />
              </PaperCard>
            ) : null}
            {trade.pending ? (
              <PaperCard>
                <AppText type="subtitle">Checking fill status</AppText>
                <AppText>
                  A request may have completed even when the response was lost. This review stays locked until the saved
                  fill is found.
                </AppText>
                <PaperButton
                  title={trade.busy ? 'Checking…' : 'Check saved fill'}
                  disabled={trade.busy || !trade.available}
                  onPress={() => void trade.controller.reconcile()}
                />
                <Link href="/paper/positions">
                  <AppText type="link">View paper positions</AppText>
                </Link>
              </PaperCard>
            ) : null}
          </>
        )}
        {!trade.ready && trade.available ? (
          <PaperButton title="Retry saved fill status" onPress={() => void trade.controller.restore()} />
        ) : null}
        {trade.error ? (
          <AppText selectable accessibilityRole="alert">
            {trade.error}
          </AppText>
        ) : null}
        {detail.error ? <AppText selectable>{detail.error.message}</AppText> : null}
      </ScrollView>
    </AppView>
  )
}
