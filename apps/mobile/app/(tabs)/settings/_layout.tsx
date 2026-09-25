import { Stack } from 'expo-router'
import { WalletUiDropdown } from '@/components/solana/wallet-ui-dropdown'

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerTitle: 'Settings', headerRight: () => <WalletUiDropdown /> }}>
      <Stack.Screen name="index" />
    </Stack>
  )
}
