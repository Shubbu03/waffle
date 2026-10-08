import { HeaderBackButton } from '@react-navigation/elements'
import type { PaperQuote, RealOrder } from '@waffle/shared'
import { router, Stack } from 'expo-router'
import type { PropsWithChildren, Ref } from 'react'
import { Keyboard, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { DetailRow } from '@/components/signals/signal-detail-ui'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { useThemeColor } from '@/hooks/use-theme-color'
import { formatSol, formatTokens } from '@/lib/paper-state'
import { ellipsify } from '@/utils/ellipsify'

export function returnToSignal(signalId: string) {
  if (router.canGoBack()) router.back()
  else router.replace({ pathname: '/signals/[id]', params: { id: signalId } })
}

export function TradePage({
  title,
  signalId,
  scrollRef,
  children,
}: PropsWithChildren<{
  title: string
  signalId: string
  scrollRef?: Ref<ScrollView>
}>) {
  const ink = useThemeColor({}, 'text')
  const background = useThemeColor({}, 'background')
  const insets = useSafeAreaInsets()
  return (
    <AppView style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title,
          headerShown: true,
          headerTintColor: ink,
          headerStyle: { backgroundColor: background },
          headerShadowVisible: false,
          headerBackVisible: false,
          headerLeft: () => <HeaderBackButton tintColor={ink} onPress={() => returnToSignal(signalId)} />,
        }}
      />
      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingBottom: Math.max(insets.bottom, 20) + 20, gap: 16 }}
      >
        {children}
      </ScrollView>
    </AppView>
  )
}

export function TradeIdentity({ mint, description }: { mint?: string; description: string }) {
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ gap: 6 }}>
      <AppText type="subtitle" selectable>
        {mint ? ellipsify(mint, 8) : 'Token purchase'}
      </AppText>
      <AppText style={{ color: muted, fontSize: 13, lineHeight: 21 }}>{description}</AppText>
    </View>
  )
}

export function TradeAmount({
  value,
  onChange,
  max,
  disabled,
  busy,
  onQuote,
}: {
  value: string
  onChange: (value: string) => void
  max: '0.05' | '0.1'
  disabled: boolean
  busy: boolean
  onQuote: () => void
}) {
  const ink = useThemeColor({}, 'text')
  const muted = useThemeColor({}, 'muted')
  const border = useThemeColor({}, 'border')
  const surface = useThemeColor({}, 'surfaceMuted')
  return (
    <AppCard>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <AppText type="defaultSemiBold">Amount</AppText>
        <AppText style={{ color: muted, fontSize: 12 }}>Up to {max} SOL</AppText>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: border,
          backgroundColor: surface,
          borderRadius: 14,
          paddingHorizontal: 14,
        }}
      >
        <TextInput
          accessibilityLabel="Trade amount in SOL"
          value={value}
          onChangeText={onChange}
          editable={!disabled && !busy}
          keyboardType="decimal-pad"
          placeholder="0.01"
          placeholderTextColor={muted}
          style={{ flex: 1, minHeight: 60, paddingVertical: 14, color: ink, fontSize: 24 }}
        />
        <AppText style={{ color: muted }}>SOL</AppText>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {['0.01', '0.025', max].map((amount) => (
          <AppButton
            key={amount}
            title={amount}
            variant="secondary"
            disabled={disabled || busy}
            style={{ flex: 1, minHeight: 40, paddingHorizontal: 8, paddingVertical: 8 }}
            onPress={() => onChange(amount)}
          />
        ))}
      </View>
      <AppButton
        title={busy ? 'Checking token and quote…' : 'Get quote'}
        busy={busy}
        disabled={disabled}
        onPress={() => {
          Keyboard.dismiss()
          onQuote()
        }}
      />
    </AppCard>
  )
}

export function TradeQuoteDetails({ quote }: { quote: PaperQuote | RealOrder }) {
  const decimals = quote.kind === 'paper' ? quote.outputDecimals : quote.assessment?.mint.decimals
  return (
    <View style={{ gap: 10 }}>
      <DetailRow label="Network" value={quote.network === 'devnet' ? 'Devnet · test SOL' : 'Mainnet'} />
      <DetailRow label="Purchase" value={formatSol(quote.inputAmountLamports)} />
      <DetailRow label="Estimated received" value={formatTokens(quote.outputAmountRaw, decimals)} />
      <DetailRow label="Minimum received" value={formatTokens(quote.minOutputAmountRaw, decimals)} />
      <DetailRow label="Network fees & rent" value={formatSol(quote.feeLamports)} />
      <DetailRow
        label="Total SOL"
        value={formatSol((BigInt(quote.inputAmountLamports) + BigInt(quote.feeLamports)).toString())}
      />
      <DetailRow label="Slippage / price impact" value={`${quote.slippageBps / 100}% / ${quote.priceImpactPct}%`} />
      <DetailRow label="Route fee (included)" value={`${quote.fees.totalBps / 100}%`} />
      {quote.assessment ? (
        <DetailRow
          label="Pool liquidity"
          value={
            quote.assessment.pool.liquidityUsd === null
              ? `${formatSol(quote.assessment.pool.quoteReserveLamports ?? '0')} in pool · test SOL`
              : `$${quote.assessment.pool.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          }
        />
      ) : null}
    </View>
  )
}

export function TradeError({ message }: { message: string }) {
  const danger = useThemeColor({}, 'danger')
  return (
    <AppCard style={{ borderColor: danger }}>
      <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
        Unable to continue
      </AppText>
      <AppText selectable accessibilityRole="alert" style={{ color: danger, fontSize: 13, lineHeight: 21 }}>
        {message}
      </AppText>
    </AppCard>
  )
}
