import { Link } from 'expo-router'
import { Alert, Pressable } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { ellipsify } from '@/utils/ellipsify'

export function SettingsUiAccount() {
  const { session, serverLinked, signOut } = useAuth()
  return (
    <AppView>
      <AppText type="subtitle">Account</AppText>
      {session ? (
        <>
          <AppText selectable>{ellipsify(session.walletAddress, 8)}</AppText>
          <AppText>{serverLinked ? 'Signed in to waffle' : 'Session offline · cached browsing available'}</AppText>
          {!serverLinked ? (
            <Link href="/sign-in">
              <AppText type="link">Retry sign-in</AppText>
            </Link>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={async () => {
              try {
                await signOut()
              } catch {
                Alert.alert(
                  'Signed out',
                  'Wallet disconnection or secure storage could not be completed. Try again before sharing this device.',
                )
              }
            }}
          >
            <AppText type="link">Sign out</AppText>
          </Pressable>
        </>
      ) : (
        <>
          <AppText>Public signals and the wallet catalog are available without signing in.</AppText>
          <Link href="/sign-in">
            <AppText type="link">Sign in with your wallet</AppText>
          </Link>
        </>
      )}
    </AppView>
  )
}
