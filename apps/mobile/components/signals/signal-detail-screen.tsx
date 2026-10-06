import {
  PUMP_SWAP_PROGRAM_ID,
  SCORE_REASON_GROUPS,
  type ScoreReasonCode,
  SPL_TOKEN_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from '@waffle/shared'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { AppExternalLink } from '@/components/app-external-link'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { CopyableValue, DetailRow, SnapshotMetric } from '@/components/signals/signal-detail-ui'
import { useSignalClock, useSignalDetail } from '@/components/signals/use-signals'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { ConnectionState } from '@/components/ui/connection-state'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'
import { useCatalogWallets } from '@/components/wallets/use-wallets'
import { useThemeColor } from '@/hooks/use-theme-color'
import { formatSol, formatTokens } from '@/lib/paper-state'
import { signalEvidenceLabel } from '@/lib/signal-evidence-state'
import { copyBlockReason, signalDataLabel } from '@/lib/signal-state'
import { ellipsify } from '@/utils/ellipsify'

const reasonText: Record<ScoreReasonCode, string> = {
  supported_buy: 'Confirmed supported buy',
  unsupported_or_failed_transaction: 'Unsupported or failed transaction',
  fresh_signal: 'Within the age and slot limits',
  stale_signal: 'Too old or stream health unavailable',
  mint_safe: 'Mint and freeze authorities disabled',
  mint_unavailable_or_unsafe: 'Token data missing, expired, or checks failed',
  pool_liquid: 'Liquidity and freshness requirements met',
  pool_unavailable_or_shallow: 'Liquidity missing, expired, or below the minimum',
  quote_available: 'A copy-size quote was available',
  quote_unavailable: 'Copy-size quote missing or expired',
  holders_acceptable: 'Top 10 holders within the limit',
  holders_missing_stale_or_concentrated: 'Holder data missing, expired, or above the limit',
  creator_acceptable: 'Creator holdings within the limit',
  creator_missing_stale_or_concentrated: 'Creator data missing, expired, or above the limit',
  oracle_agrees: 'Matching oracle price within the limit',
  oracle_none_or_stale: 'No usable matching oracle data',
  oracle_deviation_high: 'Oracle price difference exceeds the limit',
}
const checkNames = [
  'Transaction',
  'Freshness',
  'Token controls',
  'Pool liquidity',
  'Quote availability',
  'Top holders',
  'Creator holdings',
  'Oracle price',
]
const dateLabel = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown'

export function SignalDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const query = useSignalDetail(id)
  const catalog = useCatalogWallets()
  const now = useSignalClock()
  const [metadataOpen, setMetadataOpen] = useState(false)
  const ink = useThemeColor({}, 'text')
  const muted = useThemeColor({}, 'muted')
  const accent = useThemeColor({}, 'accentSoft')
  const border = useThemeColor({}, 'border')
  const danger = useThemeColor({}, 'danger')
  const signal = query.data?.signal
  const offline = query.isError || !query.data || query.data.fromCache || now - query.data.fetchedAt > 45_000
  const blocked = signal ? copyBlockReason(signal, offline, now) : 'Signal unavailable.'
  const snapshot = signal?.snapshot
  const assessment = snapshot?.assessment
  const wallet = catalog.data?.find((entry) => entry.id === signal?.walletId)
  const mint = snapshot?.mint?.address === signal?.mintAddress ? snapshot?.mint : null
  const pool =
    snapshot?.pool?.baseMint === signal?.mintAddress && snapshot?.pool?.quoteMint === WRAPPED_SOL_MINT
      ? snapshot.pool
      : null
  const quote =
    snapshot?.quote?.outputMint === signal?.mintAddress && snapshot?.quote?.inputMint === WRAPPED_SOL_MINT
      ? snapshot.quote
      : null
  const oracle = snapshot?.oracle?.mintAddress === signal?.mintAddress ? snapshot?.oracle : null
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Signal details', headerTintColor: ink }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 36, gap: 18 }}
        refreshControl={<RefreshControl refreshing={query.isFetching} onRefresh={() => void query.refetch()} />}
      >
        {!signal || !snapshot ? (
          query.isPending ? (
            <View style={{ paddingVertical: 48, gap: 12, alignItems: 'center' }}>
              <ActivityIndicator color={ink} />
              <AppText style={{ color: muted }}>Loading signal…</AppText>
            </View>
          ) : (
            <ConnectionState
              title="Unable to load this signal"
              message="Try again in a moment."
              retry={() => void query.refetch()}
              busy={query.isFetching}
            />
          )
        ) : (
          <>
            <AppCard style={{ gap: 18 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <AppText style={{ color: muted, fontSize: 12 }}>
                  {signal.reasons[0].points > 0 ? 'TOKEN BUY' : 'TOKEN ACTIVITY'}
                </AppText>
                <View style={{ backgroundColor: accent, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 }}>
                  <AppText style={{ fontSize: 11 }}>{signalDataLabel(signal, offline, now)}</AppText>
                </View>
              </View>
              <AppText selectable type="title" style={{ fontSize: 23, lineHeight: 32 }}>
                {ellipsify(signal.mintAddress, 6)}
              </AppText>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <View style={{ gap: 4, flex: 1 }}>
                  <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
                    Assessment score
                  </AppText>
                  <AppText style={{ color: muted, fontSize: 12 }}>
                    Score v{signal.scoreVersion} ·{' '}
                    {signal.status === 'eligible'
                      ? 'Eligible when scored'
                      : signal.status === 'history-only'
                        ? 'History only'
                        : 'Checks failed'}
                  </AppText>
                </View>
                <AppText type="title" style={{ fontSize: 40, lineHeight: 48, fontVariant: ['tabular-nums'] }}>
                  {signal.score}
                  <AppText style={{ color: muted, fontSize: 16 }}>/100</AppText>
                </AppText>
              </View>
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="Assessment score"
                accessibilityValue={{ min: 0, max: 100, now: signal.score }}
                style={{ height: 7, borderRadius: 4, backgroundColor: border, overflow: 'hidden' }}
              >
                <View style={{ height: '100%', width: `${signal.score}%`, backgroundColor: ink }} />
              </View>
              <View style={{ borderTopWidth: 1, borderTopColor: border, paddingTop: 14, gap: 4 }}>
                <AppText type="defaultSemiBold" style={{ color: blocked ? danger : ink, fontSize: 14 }}>
                  {blocked ? 'Copy unavailable' : 'Ready for quote review'}
                </AppText>
                <AppText style={{ color: muted, fontSize: 13, lineHeight: 21 }}>
                  {blocked ?? 'Prepare a fresh quote before trading.'}
                </AppText>
              </View>
            </AppCard>

            <AppCard style={{ gap: 16 }}>
              <AppText type="subtitle" style={{ fontSize: 18 }}>
                Wallet & transaction
              </AppText>
              {wallet ? (
                <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
                  {wallet.label}
                </AppText>
              ) : null}
              <CopyableValue key={signal.walletAddress} label="Wallet address" value={signal.walletAddress} />
              <CopyableValue key={signal.mintAddress} label="Token address" value={signal.mintAddress} />
              <DetailRow
                label="Source"
                value={signal.sourceProgramId === PUMP_SWAP_PROGRAM_ID ? 'PumpSwap' : 'Other program'}
              />
              <DetailRow label="Transaction time" value={dateLabel(assessment?.transactionAt)} />
              <DetailRow label="Detected" value={dateLabel(signal.observedAt)} />
              <AppExternalLink href={`https://explorer.solana.com/tx/${signal.signature}`} asChild>
                <Pressable
                  accessibilityRole="link"
                  style={{
                    minHeight: 48,
                    borderRadius: 14,
                    backgroundColor: accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 12,
                  }}
                >
                  <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
                    View transaction
                  </AppText>
                </Pressable>
              </AppExternalLink>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: metadataOpen }}
                onPress={() => setMetadataOpen(!metadataOpen)}
                style={{
                  minHeight: 44,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <AppText style={{ fontSize: 13 }}>Transaction metadata</AppText>
                <UiIconSymbol name="chevron.down" size={18} color={ink} />
              </Pressable>
              {metadataOpen ? (
                <View style={{ gap: 12 }}>
                  <DetailRow label="Source slot" value={String(signal.slot)} />
                  <DetailRow label="Assessment slot" value={String(snapshot.currentSlot)} />
                  <DetailRow label="Assessed" value={dateLabel(assessment?.scoredAt)} />
                  <DetailRow label="Published" value={dateLabel(signal.publishedAt)} />
                  <DetailRow
                    label="Ingestion"
                    value={
                      assessment
                        ? assessment.source === 'backfill'
                          ? 'Historical backfill'
                          : 'Live detection'
                        : 'Unknown'
                    }
                  />
                  <DetailRow
                    label="Stream at assessment"
                    value={assessment ? (assessment.streamStale ? 'Degraded' : 'Healthy') : 'Unknown'}
                  />
                  <CopyableValue label="Transaction signature" value={signal.signature} />
                  <CopyableValue label="Swap program address" value={signal.sourceProgramId} />
                </View>
              ) : null}
            </AppCard>

            <View style={{ gap: 10 }}>
              <AppText type="subtitle" style={{ fontSize: 18 }}>
                Evidence snapshot
              </AppText>
              <AppText style={{ color: muted, fontSize: 12 }}>
                Recorded at assessment. Freshness is checked separately.
              </AppText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <SnapshotMetric
                  label="Pool liquidity"
                  value={
                    pool
                      ? pool.liquidityUsd.toLocaleString(undefined, {
                          style: 'currency',
                          currency: 'USD',
                          maximumFractionDigits: 2,
                        })
                      : 'Unavailable'
                  }
                  status={signalEvidenceLabel(signal, 'pool', offline, now)}
                />
                <SnapshotMetric
                  label="Top 10 holders"
                  value={
                    snapshot.holders
                      ? `${snapshot.holders.top10Pct.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
                      : 'Unavailable'
                  }
                  status={signalEvidenceLabel(signal, 'holders', offline, now)}
                />
                <SnapshotMetric
                  label="Creator holdings"
                  value={
                    snapshot.creator
                      ? `${snapshot.creator.holdingPct.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
                      : 'Unavailable'
                  }
                  status={signalEvidenceLabel(signal, 'creator', offline, now)}
                />
                <SnapshotMetric
                  label="Oracle deviation"
                  value={
                    oracle
                      ? `${(oracle.deviationBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
                      : 'Unavailable'
                  }
                  status={signalEvidenceLabel(signal, 'oracle', offline, now)}
                />
              </View>
              <AppCard>
                <DetailRow label="Token evidence" value={signalEvidenceLabel(signal, 'mint', offline, now)} />
                <DetailRow
                  label="Token program"
                  value={
                    mint ? (mint.tokenProgramId === SPL_TOKEN_PROGRAM_ID ? 'SPL Token' : 'Unsupported') : 'Unknown'
                  }
                />
                <DetailRow label="Decimals" value={mint?.decimals === undefined ? 'Unknown' : String(mint.decimals)} />
                <DetailRow
                  label="Mint authority"
                  value={mint ? (mint.mintAuthority ? 'Enabled' : 'Disabled') : 'Unknown'}
                />
                <DetailRow
                  label="Freeze authority"
                  value={mint ? (mint.freezeAuthority ? 'Enabled' : 'Disabled') : 'Unknown'}
                />
                <DetailRow label="Quote evidence" value={signalEvidenceLabel(signal, 'quote', offline, now)} />
                {quote ? (
                  <>
                    <DetailRow label="Probe input" value={formatSol(quote.inputLamports)} />
                    <DetailRow label="Probe output" value={formatTokens(quote.outputAmountRaw, mint?.decimals)} />
                  </>
                ) : null}
              </AppCard>
            </View>

            <AppCard style={{ gap: 18 }}>
              <View style={{ gap: 4 }}>
                <AppText type="subtitle" style={{ fontSize: 18 }}>
                  Score breakdown
                </AppText>
                <AppText style={{ color: muted, fontSize: 12 }}>Points awarded when assessed</AppText>
              </View>
              {signal.reasons.map((reason, index) => (
                <View key={reason.code} style={{ gap: 6 }}>
                  <View
                    style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
                  >
                    <AppText type="defaultSemiBold" style={{ fontSize: 13, flex: 1 }}>
                      {checkNames[index]}
                      {index > 4 ? <AppText style={{ color: muted, fontSize: 11 }}> · Optional</AppText> : null}
                    </AppText>
                    <AppText style={{ fontSize: 13, fontVariant: ['tabular-nums'] }}>
                      {reason.points}/{SCORE_REASON_GROUPS[index].points}
                    </AppText>
                  </View>
                  <AppText style={{ color: muted, fontSize: 12, lineHeight: 19 }}>{reasonText[reason.code]}</AppText>
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: border, overflow: 'hidden' }}>
                    <View
                      style={{
                        height: '100%',
                        width: `${(reason.points / SCORE_REASON_GROUPS[index].points) * 100}%`,
                        backgroundColor: ink,
                      }}
                    />
                  </View>
                </View>
              ))}
            </AppCard>

            <View style={{ gap: 10 }}>
              <AppButton
                title={blocked ? 'Paper copy unavailable' : 'Review paper trade'}
                disabled={!!blocked}
                onPress={() => router.push({ pathname: '/paper/[id]', params: { id } })}
              />
              {!blocked ? (
                <AppButton
                  title="Review real trade"
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/trade/[id]', params: { id } })}
                />
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
    </AppView>
  )
}
