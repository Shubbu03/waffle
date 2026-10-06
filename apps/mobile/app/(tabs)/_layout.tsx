import { Tabs } from 'expo-router'
import { View } from 'react-native'
import { UiIconSymbol, type UiIconSymbolName } from '@/components/ui/ui-icon-symbol'
import { FontFamily } from '@/constants/fonts'
import { useThemeColor } from '@/hooks/use-theme-color'

export default function TabLayout() {
  const surface = useThemeColor({}, 'surface')
  const border = useThemeColor({}, 'border')
  const active = useThemeColor({}, 'tabIconSelected')
  const muted = useThemeColor({}, 'tabIconDefault')
  const accent = useThemeColor({}, 'accentSoft')
  const icon =
    (name: UiIconSymbolName) =>
    ({ color, focused }: { color: string; focused: boolean }) => (
      <View
        style={{
          width: 52,
          height: 30,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: focused ? accent : 'transparent',
        }}
      >
        <UiIconSymbol size={22} name={name} color={color} />
      </View>
    )
  return (
    <Tabs
      initialRouteName="home"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: active,
        tabBarInactiveTintColor: muted,
        tabBarStyle: { backgroundColor: surface, borderTopColor: border, elevation: 0 },
        tabBarLabelStyle: { fontFamily: FontFamily.sansMedium, fontSize: 11 },
        tabBarItemStyle: { paddingTop: 4 },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Home', tabBarIcon: icon('house.fill') }} />
      <Tabs.Screen name="signals" options={{ title: 'Signals', tabBarIcon: icon('waveform.path') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('gearshape.fill') }} />
    </Tabs>
  )
}
