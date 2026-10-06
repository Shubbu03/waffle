import { Stack } from 'expo-router'
export default function AccountLayout() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackTitle: 'Back' }}>
      <Stack.Screen name="index" options={{ title: 'My account' }} />
      <Stack.Screen name="airdrop" options={{ title: 'Airdrop' }} />
      <Stack.Screen name="send" options={{ title: 'Send SOL' }} />
      <Stack.Screen name="receive" options={{ title: 'Receive SOL' }} />
    </Stack>
  )
}
