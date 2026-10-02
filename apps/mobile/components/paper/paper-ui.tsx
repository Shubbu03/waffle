import { Link } from 'expo-router'
import type { PropsWithChildren } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useThemeColor } from '@/hooks/use-theme-color'

export function PaperCard({ children }: PropsWithChildren) {
  const ink = useThemeColor({}, 'text')
  return <View style={{ borderWidth: 1.5, borderColor: ink, borderRadius: 18, padding: 16, gap: 10 }}>{children}</View>
}
export function PaperButton({
  title,
  onPress,
  disabled = false,
}: {
  title: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ backgroundColor: '#C8F36A', borderRadius: 14, padding: 16, opacity: disabled ? 0.45 : 1 }}
    >
      <AppText type="defaultSemiBold" style={{ color: '#17200C', textAlign: 'center' }}>
        {title}
      </AppText>
    </Pressable>
  )
}
export function PaperSignIn() {
  return (
    <PaperCard>
      <AppText type="subtitle">Sign in to paper trade</AppText>
      <AppText>Your simulated positions belong to your verified account.</AppText>
      <Link href="/sign-in">
        <AppText type="link">Sign in with your wallet</AppText>
      </Link>
    </PaperCard>
  )
}
