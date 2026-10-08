import Clipboard from '@react-native-clipboard/clipboard'
import * as Dropdown from '@rn-primitives/dropdown-menu'
import { router } from 'expo-router'
import { AccessibilityInfo, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppButton } from '@/components/ui/app-button'
import { UiIconSymbol, type UiIconSymbolName } from '@/components/ui/ui-icon-symbol'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ellipsify } from '@/utils/ellipsify'

export function HomeWalletMenu() {
  const { selectedCluster } = useCluster()
  const { session, status } = useAuth()
  const accent = useThemeColor({}, 'accent')
  const accentText = useThemeColor({}, 'accentText')
  const surface = useThemeColor({}, 'surface')
  const border = useThemeColor({}, 'border')
  const ink = useThemeColor({}, 'text')
  const insets = useSafeAreaInsets()
  if (!session) {
    return (
      <AppButton
        title="Sign in"
        variant="secondary"
        disabled={status === 'loading'}
        onPress={() => router.push('/sign-in')}
      />
    )
  }
  const items: { title: string; icon: UiIconSymbolName; onPress: () => void }[] = [
    {
      title: 'Copy wallet address',
      icon: 'doc.on.doc',
      onPress: () => {
        Clipboard.setString(session.walletAddress)
        AccessibilityInfo.announceForAccessibility('Wallet address copied')
      },
    },
    {
      title: `${selectedCluster.name}${selectedCluster.id === 'solana:mainnet' ? '' : ' · test network'}`,
      icon: 'gearshape.fill',
      onPress: () => router.push('/settings'),
    },
    { title: 'My account', icon: 'person.crop.circle', onPress: () => router.push('/account') },
    { title: 'Paper positions', icon: 'chart.bar', onPress: () => router.push('/paper/positions') },
  ]
  return (
    <Dropdown.Root style={{ flexShrink: 1 }}>
      <Dropdown.Trigger
        accessibilityLabel={`Wallet menu for ${session.walletAddress}`}
        style={{
          minHeight: 44,
          borderRadius: 24,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: accent,
          flexShrink: 1,
        }}
      >
        <UiIconSymbol name="wallet.pass.fill" size={18} color={accentText} />
        <AppText numberOfLines={1} style={{ color: accentText, fontSize: 13, flexShrink: 1 }}>
          {selectedCluster.id !== 'solana:mainnet' ? `${selectedCluster.name} · ` : ''}
          {ellipsify(session.walletAddress)}
        </AppText>
        <UiIconSymbol name="chevron.down" size={14} color={accentText} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Overlay style={StyleSheet.absoluteFill}>
          <Dropdown.Content
            align="end"
            sideOffset={8}
            insets={{ top: insets.top + 8, bottom: insets.bottom + 8, left: 16, right: 16 }}
            style={{
              backgroundColor: surface,
              borderColor: border,
              borderWidth: 1,
              borderRadius: 18,
              padding: 6,
              minWidth: 220,
            }}
          >
            {items.map((item) => (
              <Dropdown.Item
                key={item.title}
                textValue={item.title}
                onPress={item.onPress}
                style={{ minHeight: 48, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}
              >
                <UiIconSymbol name={item.icon} size={20} color={ink} />
                <AppText style={{ fontSize: 14 }}>{item.title}</AppText>
              </Dropdown.Item>
            ))}
          </Dropdown.Content>
        </Dropdown.Overlay>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}
