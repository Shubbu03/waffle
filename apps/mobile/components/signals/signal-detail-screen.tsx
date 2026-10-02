import { PUMP_SWAP_PROGRAM_ID, type ScoreReasonCode } from '@waffle/shared'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { AppExternalLink } from '@/components/app-external-link'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useSignalClock, useSignalDetail } from '@/components/signals/use-signals'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ageLabel, copyBlockReason, signalDataLabel } from '@/lib/signal-state'

const reasons: Record<ScoreReasonCode, string> = {
  supported_buy: 'Supported successful buy',
  unsupported_or_failed_transaction: 'Unsupported or failed transaction',
  fresh_signal: 'Fresh when assessed',
  stale_signal: 'Signal was stale when assessed',
  mint_safe: 'Mint and freeze authorities disabled',
  mint_unavailable_or_unsafe: 'Mint unavailable or unsafe',
  pool_liquid: 'Pool meets the liquidity floor',
  pool_unavailable_or_shallow: 'Pool unavailable or shallow',
  quote_available: 'Copy-size quote was available',
  quote_unavailable: 'Quote unavailable',
  holders_acceptable: 'Holder concentration within the limit',
  holders_missing_stale_or_concentrated: 'Holders unknown, stale, or concentrated',
  creator_acceptable: 'Creator holdings within the limit',
  creator_missing_stale_or_concentrated: 'Creator holdings unknown, stale, or concentrated',
  oracle_agrees: 'Fresh same-asset oracle agrees',
  oracle_none_or_stale: 'Oracle unknown or stale',
  oracle_deviation_high: 'Oracle deviation is high',
}
export function SignalDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const query = useSignalDetail(id)
  const now = useSignalClock()
  const ink = useThemeColor({}, 'text')
  const signal = query.data?.signal
  const offline = query.isError || !query.data || query.data.fromCache || now - query.data.fetchedAt > 45_000
  const blocked = signal ? copyBlockReason(signal, offline, now) : 'Signal unavailable.'
  const assessment = signal?.snapshot.assessment
  return (
    <AppView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Signal details', headerTintColor: ink }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 24 }}
        refreshControl={<RefreshControl refreshing={query.isFetching} onRefresh={() => void query.refetch()} />}
      >
        {!signal ? (
          <View style={{ paddingVertical: 32, gap: 12 }}>
            {query.isPending ? (
              <>
                <ActivityIndicator />
                <AppText>Loading signal…</AppText>
              </>
            ) : (
              <>
                <AppText type="subtitle">Signal unavailable</AppText>
                <AppText selectable>{query.error?.message ?? 'No cached detail is available.'}</AppText>
                <Pressable accessibilityRole="button" onPress={() => void query.refetch()}>
                  <AppText type="link">Retry</AppText>
                </Pressable>
              </>
            )}
          </View>
        ) : (
          <>
            <View style={{ gap: 8 }}>
              <AppText type="title">{signal.score}/100</AppText>
              <AppText>
                Score v{signal.scoreVersion} ·{' '}
                {signal.status === 'history-only'
                  ? 'History only'
                  : signal.status === 'suppressed'
                    ? 'Suppressed'
                    : 'Eligible at assessment'}
              </AppText>
              <AppText>
                {signalDataLabel(signal, offline, now)} · {ageLabel(assessment?.transactionAt ?? null, now)}
              </AppText>
              {offline ? <AppText>Cached detail. Reconnect and refresh before preparing a copy.</AppText> : null}
              {assessment?.streamStale || !assessment ? (
                <AppText>Source stream degraded or health unknown. Copying is disabled.</AppText>
              ) : null}
              {query.isError ? <AppText selectable>Refresh failed: {query.error.message}</AppText> : null}
            </View>
            <View style={{ gap: 8 }}>
              <AppText type="subtitle">Token</AppText>
              <AppText selectable>{signal.mintAddress}</AppText>
              <AppText type="subtitle">Watched wallet</AppText>
              <AppText selectable>{signal.walletAddress}</AppText>
              <AppText>Source: {signal.sourceProgramId === PUMP_SWAP_PROGRAM_ID ? 'PumpSwap' : 'Unknown'}</AppText>
              <AppText selectable>Source slot: {signal.slot}</AppText>
              <AppText>Observed: {new Date(signal.observedAt).toLocaleString()}</AppText>
              <AppExternalLink href={`https://explorer.solana.com/tx/${signal.signature}`}>
                <AppText type="link">View source transaction</AppText>
              </AppExternalLink>
            </View>
            <View style={{ gap: 12 }}>
              <AppText type="subtitle">Why this score</AppText>
              {signal.reasons.map((reason) => (
                <View key={reason.code} style={{ flexDirection: 'row', gap: 12, justifyContent: 'space-between' }}>
                  <AppText style={{ flex: 1 }}>{reasons[reason.code]}</AppText>
                  <AppText type="defaultSemiBold">+{reason.points}</AppText>
                </View>
              ))}
            </View>
            <View style={{ gap: 8 }}>
              <AppText type="subtitle">Evidence</AppText>
              <AppText>
                Pool liquidity at assessment:{' '}
                {signal.snapshot.pool ? `$${signal.snapshot.pool.liquidityUsd.toLocaleString()}` : 'Unknown'}
              </AppText>
              <AppText>
                Top 10 holders:{' '}
                {signal.snapshot.holders ? `${signal.snapshot.holders.top10Pct}% (snapshot)` : 'Unknown'}
              </AppText>
              <AppText>
                Creator holdings:{' '}
                {signal.snapshot.creator ? `${signal.snapshot.creator.holdingPct}% (snapshot)` : 'Unknown'}
              </AppText>
              <AppText>
                Oracle:{' '}
                {signal.snapshot.oracle
                  ? `${signal.snapshot.oracle.deviationBps} bps deviation (snapshot)`
                  : 'Unknown — zero points, not a rejection'}
              </AppText>
              {assessment ? (
                Object.entries(assessment.evidence).map(([name, evidence]) => (
                  <AppText key={name} style={{ fontSize: 13, opacity: 0.8 }}>
                    {name}:{' '}
                    {evidence.status === 'fresh' && evidence.expiresAt && Date.parse(evidence.expiresAt) <= now
                      ? 'stale'
                      : evidence.status}
                    {evidence.expiresAt ? ` · expires ${new Date(evidence.expiresAt).toLocaleTimeString()}` : ''}
                  </AppText>
                ))
              ) : (
                <AppText>Evidence freshness unknown.</AppText>
              )}
            </View>
            <View style={{ borderWidth: 1.5, borderColor: ink, borderRadius: 18, padding: 16, gap: 8 }}>
              <AppText type="subtitle">Copy safety</AppText>
              <AppText>
                {blocked ?? 'Checks allow preparing a fresh quote. Every copy still needs a new quote.'}
              </AppText>
              <Pressable
                disabled={!!blocked}
                accessibilityRole="button"
                accessibilityState={{ disabled: !!blocked }}
                accessibilityHint={blocked ?? 'Review a simulated copy with a fresh quote.'}
                onPress={() => router.push({ pathname: '/paper/[id]', params: { id } })}
                style={{ opacity: blocked ? 0.5 : 1, paddingVertical: 12 }}
              >
                <AppText type="defaultSemiBold">Review paper copy</AppText>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </AppView>
  )
}
