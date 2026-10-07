import 'react-native-reanimated'
import { PortalHost } from '@rn-primitives/portal'
import Constants from 'expo-constants'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useCallback } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'
import { AppProviders } from '@/components/app-providers'
import { AppText } from '@/components/app-text'
import { useAppTheme } from '@/components/app-theme'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { resolveDevelopmentApiUrl } from '@/lib/development-api-url'

AppConfig.apiUrl = resolveDevelopmentApiUrl(AppConfig.apiUrl, Constants.expoConfig?.hostUri, __DEV__, Platform.OS)
SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    PlaywriteZA: require('../assets/fonts/Playwrite_ZA/static/PlaywriteZA-Regular.ttf'),
    Poppins: require('../assets/fonts/Poppins/Poppins-Regular.ttf'),
    'Poppins-Medium': require('../assets/fonts/Poppins/Poppins-Medium.ttf'),
    'Poppins-Light': require('../assets/fonts/Poppins/Poppins-Light.ttf'),
  })
  const onLayout = useCallback(() => {
    void SplashScreen.hideAsync()
  }, [])
  if (!loaded && !error) return null
  return (
    <View style={{ flex: 1 }} onLayout={onLayout}>
      <AppProviders>
        <RootNavigator />
        <AppStatusBar />
        <PortalHost />
      </AppProviders>
    </View>
  )
}

function AppStatusBar() {
  const { isDark } = useAppTheme()
  return <StatusBar style={isDark ? 'light' : 'dark'} />
}

function RootNavigator() {
  const { status, isAuthenticated, serverLinked } = useAuth()
  const ink = useThemeColor({}, 'text')
  if (status === 'loading')
    return (
      <AppView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={ink} />
        <AppText>Opening waffle…</AppText>
      </AppView>
    )
  return (
    <Stack initialRouteName="index" screenOptions={{ headerShown: false, headerShadowVisible: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="wallets" />
      <Stack.Screen name="account" />
      <Stack.Screen name="signals/[id]" />
      <Stack.Screen name="signals/wallet/[walletId]" />
      <Stack.Screen name="paper/[id]" />
      <Stack.Screen name="paper/positions/index" />
      <Stack.Screen name="paper/positions/[id]" />
      <Stack.Screen name="trade/[id]" />
      <Stack.Screen name="+not-found" />
      <Stack.Protected guard={!isAuthenticated}>
        <Stack.Screen name="welcome" />
      </Stack.Protected>
      <Stack.Protected guard={!isAuthenticated || !serverLinked}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  )
}
