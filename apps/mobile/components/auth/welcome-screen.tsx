import { Image } from 'expo-image'
import { router } from 'expo-router'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { AppButton } from '@/components/ui/app-button'
import { FontFamily } from '@/constants/fonts'
import { useThemeColor } from '@/hooks/use-theme-color'

export function WelcomeScreen() {
  const auth = useAuth()
  const accent = useThemeColor({}, 'accent')
  const danger = useThemeColor({}, 'danger')
  const [error, setError] = useState<string | null>(null)
  const connect = async () => {
    setError(null)
    try {
      await auth.signIn()
      router.replace('/(tabs)/home')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed. Please try again.')
    }
  }
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 24 }} showsVerticalScrollIndicator={false}>
          <View style={{ flex: 1, minHeight: 300, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
            <View
              style={{
                backgroundColor: accent,
                width: 120,
                height: 120,
                borderRadius: 32,
                borderCurve: 'continuous',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Image
                source={require('../../assets/images/waffle.png')}
                style={{ width: 104, height: 104 }}
                contentFit="contain"
                accessibilityLabel="Waffle mascot"
              />
            </View>
            <AppText
              accessibilityRole="header"
              style={{ fontFamily: FontFamily.wordmark, fontSize: 36, lineHeight: 72, textAlign: 'center' }}
            >
              waffle
            </AppText>
          </View>
          <View style={{ gap: 12 }}>
            {error ? (
              <AppText
                selectable
                accessibilityLiveRegion="polite"
                style={{ color: danger, fontSize: 13, textAlign: 'center' }}
              >
                {error}
              </AppText>
            ) : null}
            <AppButton
              title="Get started"
              busy={auth.isSigningIn}
              disabled={auth.status === 'loading'}
              onPress={() => void connect()}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </AppView>
  )
}
