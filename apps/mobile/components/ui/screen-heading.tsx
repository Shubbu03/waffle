import { View } from 'react-native'
import { AppText } from '@/components/app-text'
import { HomeWalletMenu } from '@/components/home/home-wallet-menu'
import { useThemeColor } from '@/hooks/use-theme-color'

export function ScreenHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ padding: 20, paddingBottom: 16, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText type="title" style={{ flex: 1 }}>
          {title}
        </AppText>
        <HomeWalletMenu />
      </View>
      {subtitle ? <AppText style={{ color: muted, fontSize: 14, lineHeight: 21 }}>{subtitle}</AppText> : null}
    </View>
  )
}
