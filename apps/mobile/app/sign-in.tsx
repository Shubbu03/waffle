import { Button } from '@react-navigation/elements'
import { Image } from 'expo-image'
import { router } from 'expo-router'
import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { AppConfig } from '@/constants/app-config'

export default function SignIn() {
  const { signIn } = useAuth()
  return (
    <AppView
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'stretch',
      }}
    >
      <SafeAreaView
        style={{
          flex: 1,
          justifyContent: 'space-between',
        }}
      >
        {/* Dummy view to push the next view to the center. */}
        <View />
        <View style={{ alignItems: 'center', gap: 16 }}>
          <AppText type="title">{AppConfig.name}</AppText>
          <Image source={require('../assets/images/icon.png')} style={{ width: 128, height: 128 }} />
        </View>
        <View style={{ marginBottom: 16 }}>
          <Button
            variant="filled"
            style={{ marginHorizontal: 16 }}
            onPress={async () => {
              await signIn()
              // Navigate after signing in. You may want to tweak this to ensure sign-in is
              // successful before navigating.
              router.replace('/')
            }}
          >
            Connect
          </Button>
        </View>
      </SafeAreaView>
    </AppView>
  )
}
