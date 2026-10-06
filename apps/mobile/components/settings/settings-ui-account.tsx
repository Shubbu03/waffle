import { router } from 'expo-router'
import { Alert, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { AppButton } from '@/components/ui/app-button'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ellipsify } from '@/utils/ellipsify'

export function SettingsUiAccount() {
  const { session, serverLinked, signOut } = useAuth()
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ gap: 12 }}>
      <AppText type="subtitle">Account</AppText>
      {session ? (
        <>
          <AppText selectable type="defaultSemiBold">
            {ellipsify(session.walletAddress, 8)}
          </AppText>
          <AppText style={{ color: muted, fontSize: 14 }}>
            {serverLinked ? 'Signed in to waffle' : 'Session offline · saved browsing available'}
          </AppText>
          {!serverLinked ? (
            <AppButton title="Verify account" variant="secondary" onPress={() => router.push('/sign-in')} />
          ) : null}
          <AppButton
            title="Sign out"
            variant="secondary"
            onPress={() => {
              void signOut().catch(() =>
                Alert.alert(
                  'Signed out',
                  'Wallet disconnection or secure storage could not be completed. Try again before sharing this device.',
                ),
              )
            }}
          />
        </>
      ) : (
        <>
          <AppText style={{ color: muted, fontSize: 14 }}>
            Sign in to save your follows, alerts, and simulated positions.
          </AppText>
          <AppButton title="Sign in with wallet" onPress={() => router.push('/sign-in')} />
        </>
      )}
    </View>
  )
}
