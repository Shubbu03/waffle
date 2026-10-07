import { router } from 'expo-router'
import { AppButton } from '@/components/ui/app-button'

export function TrackWalletButton() {
  return (
    <AppButton
      title="＋ Track wallet"
      onPress={() => router.push('/track-wallet')}
      style={{ minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 }}
    />
  )
}
