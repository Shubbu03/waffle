import { Link } from 'expo-router'
import { Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ageLabel, type SignalView } from '@/lib/signal-state'
import type { SignalWallet } from '@/lib/signal-wallets'
import { ellipsify } from '@/utils/ellipsify'

export function SignalWalletCard({ wallet, view, now }: { wallet: SignalWallet; view: SignalView; now: number }) {
  const surface = useThemeColor({}, 'surface')
  const border = useThemeColor({}, 'border')
  const muted = useThemeColor({}, 'muted')
  const accent = useThemeColor({}, 'accentSoft')
  const ink = useThemeColor({}, 'text')
  return (
    <Link href={{ pathname: '/signals/wallet/[walletId]', params: { walletId: wallet.id, view } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View signals from ${wallet.label || ellipsify(wallet.address, 6)}`}
        style={{
          backgroundColor: surface,
          borderWidth: 1,
          borderColor: border,
          borderRadius: 20,
          padding: 18,
          gap: 16,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ backgroundColor: accent, padding: 12, borderRadius: 14 }}>
            <UiIconSymbol name="wallet.pass.fill" size={22} color={ink} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <AppText type="defaultSemiBold" numberOfLines={2}>
              {wallet.label || 'Tracked wallet'}
            </AppText>
            <AppText style={{ color: muted, fontSize: 13 }}>{ellipsify(wallet.address, 6)}</AppText>
          </View>
          <UiIconSymbol name="chevron.right" size={20} color={muted} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <AppText style={{ color: muted, fontSize: 12 }}>
            {wallet.latestActivityAt ? `Last buy ${ageLabel(wallet.latestActivityAt, now)}` : 'No signals yet'}
          </AppText>
          {wallet.active === false ? <AppText style={{ color: muted, fontSize: 12 }}>· Tracking paused</AppText> : null}
        </View>
      </Pressable>
    </Link>
  )
}
