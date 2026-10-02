import { Tabs } from 'expo-router'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      {/* The index redirects to the account screen */}
      <Tabs.Screen name="index" options={{ tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="wallet.pass.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="wallets"
        options={{
          title: 'Wallets',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="person.2.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="gearshape.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="demo"
        options={{
          title: 'Demo',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="ladybug.fill" color={color} />,
        }}
      />
    </Tabs>
  )
}
