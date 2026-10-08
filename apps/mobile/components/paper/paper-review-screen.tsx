import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef } from 'react'
import { ActivityIndicator, Alert, type ScrollView, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useSignalClock, useSignalDetail } from '@/components/signals/use-signals'
import {
  returnToSignal,
  TradeAmount,
  TradeError,
  TradeIdentity,
  TradePage,
  TradeQuoteDetails,
} from '@/components/trade/trade-ui'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { useThemeColor } from '@/hooks/use-theme-color'
import { formatSol, formatTokens, paperQuoteFresh, paperReviewBlock } from '@/lib/paper-state'
import { PaperSignIn } from './paper-ui'
import { usePaperTrade } from './use-paper'

export function PaperReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const signalId = typeof id === 'string' ? id : ''
  const detail = useSignalDetail(signalId)
  const now = useSignalClock()
  const muted = useThemeColor({}, 'muted')
  const ink = useThemeColor({}, 'text')
  const scroll = useRef<ScrollView>(null)
  const blocked = paperReviewBlock(
    detail.data?.signal,
    detail.isError || !detail.data || detail.data.fromCache || now - detail.data.fetchedAt > 45_000,
    now,
  )
  const trade = usePaperTrade(signalId, blocked)
  const quote = trade.quote
  const fresh = quote !== null && paperQuoteFresh(quote, now)
  useEffect(() => {
    // Confirmation replaces the quote with recovery or success; keep that outcome in view.
    if (quote || trade.pending || trade.position || trade.error) scroll.current?.scrollTo({ y: 0, animated: true })
  }, [quote, trade.pending, trade.position, trade.error])
  return (
    <TradePage title="Paper trade" signalId={signalId} scrollRef={scroll}>
      <TradeIdentity
        mint={detail.data?.signal.mintAddress}
        description="Practice with a simulated purchase. No SOL is spent and no wallet approval is needed."
      />
      {trade.error ? <TradeError message={trade.error} /> : null}
      {!trade.isAuthenticated ? (
        <PaperSignIn />
      ) : !trade.serverLinked ? (
        <AppText>Reconnect to verify your account.</AppText>
      ) : null}
      {trade.position ? (
        <AppCard>
          <AppText type="subtitle">Paper trade saved</AppText>
          <AppText style={{ color: muted, fontSize: 13 }}>Your simulated position is ready.</AppText>
          <AppText selectable>
            {formatTokens(trade.position.fill.outputAmountRaw, trade.position.entryQuote.outputDecimals)}
          </AppText>
          <AppText style={{ color: muted, fontSize: 13 }}>
            Entry cost: {formatSol(trade.position.fill.totalDebitLamports)}
          </AppText>
          <AppButton
            title="View paper position"
            onPress={() =>
              router.replace({ pathname: '/paper/positions/[id]', params: { id: trade.position?.id ?? '' } })
            }
          />
        </AppCard>
      ) : trade.pending ? (
        <AppCard>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {trade.busy ? <ActivityIndicator color={ink} /> : null}
            <AppText type="subtitle" style={{ flex: 1 }}>
              {trade.busy ? 'Confirming paper trade…' : 'Check paper trade status'}
            </AppText>
          </View>
          <AppText style={{ color: muted, fontSize: 13, lineHeight: 21 }}>
            We’re checking whether this purchase was saved. You can leave this screen; the check resumes when you
            return.
          </AppText>
          <AppButton
            title="Check status"
            busy={trade.busy}
            disabled={!trade.available}
            onPress={() => void trade.controller.reconcile()}
          />
          <AppButton title="View paper positions" variant="secondary" onPress={() => router.push('/paper/positions')} />
          {trade.canStartOver ? (
            <AppButton
              title="Start a new paper trade"
              variant="quiet"
              disabled={trade.busy || !trade.available}
              onPress={() =>
                Alert.alert(
                  'Start a new simulation?',
                  'No saved position was found. The earlier request could still finish and appear in your paper positions. No real funds are involved.',
                  [
                    { text: 'Keep checking', style: 'cancel' },
                    { text: 'Start new', onPress: () => void trade.controller.startOver() },
                  ],
                )
              }
            />
          ) : null}
        </AppCard>
      ) : blocked ? (
        <AppCard>
          <AppText style={{ fontSize: 14 }}>{blocked}</AppText>
          <AppButton title="Refresh signal" busy={detail.isFetching} onPress={() => void detail.refetch()} />
        </AppCard>
      ) : quote ? (
        <AppCard>
          <AppText type="subtitle">Review simulated purchase</AppText>
          <TradeQuoteDetails quote={quote} />
          <AppText style={{ color: muted, fontSize: 12 }}>
            {fresh
              ? `Quote valid for ${Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000))}s`
              : 'Quote expired. Get a new quote to continue.'}
          </AppText>
          <AppButton
            title="Confirm paper trade"
            busy={trade.busy}
            disabled={!trade.available || !fresh || !trade.ready}
            onPress={() => void trade.controller.confirm()}
          />
          <AppButton
            title="Get a new quote"
            variant="secondary"
            disabled={trade.busy || !trade.available}
            onPress={() => void trade.controller.prepare()}
          />
          <AppButton
            title="Change amount"
            variant="quiet"
            disabled={trade.busy}
            onPress={() => trade.controller.invalidate()}
          />
        </AppCard>
      ) : (
        <TradeAmount
          value={trade.size}
          onChange={(size) => trade.controller.setSize(size)}
          max="0.1"
          disabled={!trade.available || !trade.ready}
          busy={trade.busy}
          onQuote={() => void trade.controller.prepare()}
        />
      )}
      {!trade.ready && trade.available ? (
        <AppButton title="Retry saved status" onPress={() => void trade.controller.restore()} />
      ) : null}
      <AppButton title="Back to signal" variant="quiet" onPress={() => returnToSignal(signalId)} />
    </TradePage>
  )
}
