import { router } from 'expo-router'
import { View } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { useThemeColor } from '@/hooks/use-theme-color'

export function ConnectionState({
  title = 'Unable to connect',
  message,
  retry,
  busy = false,
}: {
  title?: string
  message?: string
  retry: () => void
  busy?: boolean
}) {
  const muted = useThemeColor({}, 'muted')
  return (
    <AppCard>
      <AppText type="subtitle">{title}</AppText>
      <AppText style={{ color: muted, fontSize: 14, lineHeight: 22 }}>
        {message ?? 'The feed could not reach waffle. Check your connection and try again.'}
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AppButton title="Retry" onPress={retry} busy={busy} />
        <AppButton title="Settings" variant="secondary" onPress={() => router.push('/(tabs)/settings')} />
      </View>
    </AppCard>
  )
}
