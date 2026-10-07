import Clipboard from '@react-native-clipboard/clipboard'
import { router } from 'expo-router'
import { useState } from 'react'
import { AccessibilityInfo, Alert, Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { SettingsAction, SettingsGroup } from '@/components/settings/settings-ui'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ellipsify } from '@/utils/ellipsify'

export function SettingsUiAccount() {
  const { session, serverLinked, signOut } = useAuth()
  const [signingOut, setSigningOut] = useState(false)
  const muted = useThemeColor({}, 'muted')
  const ink = useThemeColor({}, 'text')
  const accent = useThemeColor({}, 'accentSoft')
  const disconnect = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } catch {
      Alert.alert(
        'Signed out',
        'Wallet disconnection or secure storage could not be completed. Try again before sharing this device.',
      )
    } finally {
      setSigningOut(false)
    }
  }
  return (
    <SettingsGroup title="Account">
      {session ? (
        <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ padding: 11, borderRadius: 13, backgroundColor: accent }}>
            <UiIconSymbol name="wallet.pass.fill" color={ink} size={22} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open connected wallet"
            onPress={() => router.push('/account')}
            style={{ flex: 1, gap: 2, minHeight: 44, justifyContent: 'center' }}
          >
            <AppText style={{ color: muted, fontSize: 12 }}>Connected wallet</AppText>
            <AppText type="defaultSemiBold" numberOfLines={1} style={{ fontSize: 15 }}>
              {ellipsify(session.walletAddress, 6)}
            </AppText>
            {!serverLinked ? <AppText style={{ color: muted, fontSize: 12 }}>Session offline</AppText> : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy wallet address"
            style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
            onPress={() => {
              Clipboard.setString(session.walletAddress)
              AccessibilityInfo.announceForAccessibility('Wallet address copied')
            }}
          >
            <UiIconSymbol name="doc.on.doc" size={18} color={muted} />
          </Pressable>
        </View>
      ) : (
        <SettingsAction title="Sign in with wallet" onPress={() => router.push('/sign-in')} />
      )}
      {session && !serverLinked ? (
        <SettingsAction title="Verify account" onPress={() => router.push('/sign-in')} />
      ) : null}
      <SettingsAction title="Paper positions" onPress={() => router.push('/paper/positions')} />
      {session ? (
        <SettingsAction
          title={signingOut ? 'Signing out…' : 'Sign out'}
          destructive
          disabled={signingOut}
          onPress={() => void disconnect()}
        />
      ) : null}
    </SettingsGroup>
  )
}
