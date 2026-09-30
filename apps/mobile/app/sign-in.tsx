import { Image } from 'expo-image'
import { router } from 'expo-router'
import { Alert, Pressable, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { FontFamily } from '@/constants/fonts'
import { useThemeColor } from '@/hooks/use-theme-color'

export default function SignIn() {
  const { signIn } = useAuth()
  const buttonBg = useThemeColor({}, 'text')
  const buttonFg = useThemeColor({}, 'background')
  const { width: screenWidth } = useWindowDimensions()
  // waffle.png is 749x800 — half-size mark +20%, keep aspect.
  const logoWidth = Math.round(screenWidth * 0.53)
  const logoHeight = Math.round((logoWidth * 800) / 749)

  return (
    <AppView style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, justifyContent: 'space-between' }}>
        <View />
        <View style={{ alignItems: 'center', gap: 0 }}>
          <Image
            source={require('../assets/images/waffle.png')}
            style={{ width: logoWidth, height: logoHeight }}
            contentFit="contain"
            accessibilityLabel="Waffle logo"
          />
          {/* TODO(brand): replace with the waffle wordmark SVG when it lands. */}
          <View style={{ width: '48%' }}>
            <AppText
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{
                fontFamily: FontFamily.wordmark,
                fontSize: 96,
                lineHeight: 150,
                paddingVertical: 1,
                textAlign: 'center',
                textAlignVertical: 'center',
              }}
            >
              waffle
            </AppText>
          </View>
        </View>
        <View style={{ marginBottom: 16, marginHorizontal: 16 }}>
          <AppText type="default" style={{ textAlign: 'center', marginBottom: 12 }}>
            Watch the whales. Copy with care.
          </AppText>
          <Pressable
            accessibilityRole="button"
            style={{ backgroundColor: buttonBg, borderRadius: 16, paddingVertical: 16, alignItems: 'center' }}
            onPress={async () => {
              try {
                await signIn()
                router.replace('/')
              } catch (error) {
                Alert.alert('Wallet sign-in failed', error instanceof Error ? error.message : 'Please try again.')
              }
            }}
          >
            <AppText type="defaultSemiBold" lightColor={buttonFg} darkColor={buttonFg}>
              Connect wallet
            </AppText>
          </Pressable>
        </View>
      </SafeAreaView>
    </AppView>
  )
}
