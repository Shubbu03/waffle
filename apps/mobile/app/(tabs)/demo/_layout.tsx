import { Stack } from 'expo-router'
import { WalletUiDropdown } from '@/components/solana/wallet-ui-dropdown'

export default function DemoLayout() {
  return (
    <Stack screenOptions={{ headerTitle: 'Demo', headerRight: () => <WalletUiDropdown /> }}>
      <Stack.Screen name="index" />
    </Stack>
  )
}
