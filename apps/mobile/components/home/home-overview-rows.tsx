import type { SignalSummary } from '@waffle/shared'
import { Link } from 'expo-router'
import { Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ageLabel, signalDataLabel } from '@/lib/signal-state'
import type { SignalWallet } from '@/lib/signal-wallets'
import { ellipsify } from '@/utils/ellipsify'

export function HomeWatchlistRow({ wallet, now, last }: { wallet: SignalWallet; now: number; last: boolean }) {
  const ink = useThemeColor({}, 'text')
  const muted = useThemeColor({}, 'muted')
  const accent = useThemeColor({}, 'accentSoft')
  const border = useThemeColor({}, 'border')
  const pressedColor = useThemeColor({}, 'surfaceMuted')
  const name = wallet.label || ellipsify(wallet.address, 6)
  return (
    <Link href={{ pathname: '/signals/wallet/[walletId]', params: { walletId: wallet.id, view: 'following' } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View signals from ${name}${wallet.active === false ? ', tracking paused' : ''}`}
        android_ripple={{ color: pressedColor }}
        style={{
          width: '100%',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 14,
          minHeight: 84,
          borderBottomWidth: last ? 0 : 1,
          borderBottomColor: border,
        }}
      >
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 13,
            backgroundColor: accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <UiIconSymbol name="wallet.pass.fill" size={20} color={ink} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText type="defaultSemiBold" numberOfLines={1} style={{ fontSize: 14, lineHeight: 20 }}>
            {name}
          </AppText>
          <AppText style={{ color: muted, fontSize: 12, lineHeight: 18 }}>{ellipsify(wallet.address, 6)}</AppText>
          <AppText style={{ color: muted, fontSize: 12, lineHeight: 18 }}>
            {wallet.latestActivityAt ? `Last buy ${ageLabel(wallet.latestActivityAt, now)}` : 'No buys yet'}
            {wallet.active === false ? ' · Paused' : ''}
          </AppText>
        </View>
        <UiIconSymbol name="chevron.right" size={20} color={muted} />
      </Pressable>
    </Link>
  )
}

export function HomeActivityRow({
  signal,
  walletName,
  offline,
  now,
  last,
}: {
  signal: SignalSummary
  walletName?: string
  offline: boolean
  now: number
  last: boolean
}) {
  const muted = useThemeColor({}, 'muted')
  const border = useThemeColor({}, 'border')
  const pressedColor = useThemeColor({}, 'surfaceMuted')
  const status =
    signal.status === 'eligible'
      ? 'Eligible at assessment'
      : signal.status === 'history-only'
        ? 'History only'
        : 'Suppressed'
  return (
    <Link href={{ pathname: '/signals/[id]', params: { id: signal.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View buy from ${walletName || ellipsify(signal.walletAddress, 6)} for ${ellipsify(signal.mintAddress, 6)}, assessment score ${signal.score} of 100, ${status}`}
        android_ripple={{ color: pressedColor }}
        style={{
          width: '100%',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 88,
          paddingVertical: 14,
          borderBottomWidth: last ? 0 : 1,
          borderBottomColor: border,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <AppText type="defaultSemiBold" numberOfLines={1} style={{ fontSize: 14, lineHeight: 20 }}>
            {walletName || ellipsify(signal.walletAddress, 6)}
          </AppText>
          <AppText style={{ fontSize: 13, lineHeight: 18 }}>Bought {ellipsify(signal.mintAddress, 6)}</AppText>
          <AppText style={{ color: muted, fontSize: 12, lineHeight: 18 }}>
            {ageLabel(signal.observedAt, now)} · {signalDataLabel(signal, offline, now)} · {status}
          </AppText>
        </View>
        <View style={{ width: 48, flexShrink: 0, alignItems: 'flex-end', gap: 2 }}>
          <AppText type="defaultSemiBold" style={{ fontSize: 20, lineHeight: 26, fontVariant: ['tabular-nums'] }}>
            {signal.score}
          </AppText>
          <AppText style={{ color: muted, fontSize: 11, lineHeight: 16 }}>of 100</AppText>
        </View>
      </Pressable>
    </Link>
  )
}
