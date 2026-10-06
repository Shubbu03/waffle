import { router } from 'expo-router'
import type { PropsWithChildren } from 'react'
import { AppText } from '@/components/app-text'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'

export function PaperCard({ children }: PropsWithChildren) {
  return <AppCard>{children}</AppCard>
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
  return <AppButton title={title} onPress={onPress} disabled={disabled} />
}
export function PaperSignIn() {
  return (
    <PaperCard>
      <AppText type="subtitle">Sign in to paper trade</AppText>
      <AppText>Your simulated positions belong to your verified account.</AppText>
      <AppButton title="Sign in with wallet" onPress={() => router.push('/sign-in')} />
    </PaperCard>
  )
}
