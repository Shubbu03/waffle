import { router, Stack } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { useTrackWallet } from '@/components/wallets/use-wallets'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ApiError } from '@/lib/api-error'
import { checkWalletAddress, trackErrorMessage } from '@/lib/wallet-validation'

export function TrackWalletScreen() {
  const { session, serverLinked, status } = useAuth()
  const ink = useThemeColor({}, 'text')
  const background = useThemeColor({}, 'background')
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Track wallet',
          headerTintColor: ink,
          headerStyle: { backgroundColor: background },
          headerShadowVisible: false,
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, paddingBottom: 36, gap: 16 }}
        >
          {status === 'loading' ? (
            <ActivityIndicator color={ink} />
          ) : !session || !serverLinked ? (
            <AppCard>
              <AppText>{session ? 'Reconnect your account to track a wallet.' : 'Sign in to track a wallet.'}</AppText>
              <AppButton
                title={session ? 'Verify account' : 'Sign in with wallet'}
                onPress={() => router.push('/sign-in')}
              />
            </AppCard>
          ) : (
            <TrackWalletForm />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </AppView>
  )
}

function TrackWalletForm() {
  const track = useTrackWallet()
  const ink = useThemeColor({}, 'text')
  const surface = useThemeColor({}, 'surface')
  const border = useThemeColor({}, 'border')
  const muted = useThemeColor({}, 'muted')
  const danger = useThemeColor({}, 'danger')
  const warning = useThemeColor({}, 'warning')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const onSubmit = () => {
    if (track.isPending) return
    const check = checkWalletAddress(address)
    if (!check.ok) {
      setError(check.message)
      return
    }
    setError(null)
    track.mutate(
      { address: check.address },
      {
        onSuccess: () => Keyboard.dismiss(),
        onError: (mutationError) => {
          setError(
            mutationError instanceof ApiError
              ? trackErrorMessage(mutationError.status, mutationError.code)
              : 'Could not track that wallet. Try again.',
          )
        },
      },
    )
  }
  if (track.isSuccess) {
    const result = track.data
    return (
      <View style={{ gap: 16 }}>
        <AppText type="subtitle">Wallet tracked</AppText>
        <AppText selectable style={{ color: muted, fontSize: 13 }}>
          {result.wallet.address}
        </AppText>
        <AppText style={{ color: muted, fontSize: 13 }}>
          {result.followed ? 'Added to Following.' : 'This wallet is now tracked.'}
        </AppText>
        {result.veryActive ? (
          <AppText selectable accessibilityLiveRegion="polite" style={{ color: warning, fontSize: 13 }}>
            This wallet is very active, so signals may lag behind.
          </AppText>
        ) : null}
        <AppButton
          title="View signals"
          onPress={() =>
            router.replace({
              pathname: '/signals/wallet/[walletId]',
              params: { walletId: result.wallet.id, view: result.followed ? 'following' : 'all' },
            })
          }
        />
      </View>
    )
  }
  return (
    <View style={{ gap: 16 }}>
      <AppText style={{ color: muted, fontSize: 13 }}>
        Add up to 3 Solana wallets. Their PumpSwap buys appear in Following.
      </AppText>
      <View style={{ gap: 8 }}>
        <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
          Wallet address
        </AppText>
        <TextInput
          value={address}
          onChangeText={(value) => {
            setAddress(value)
            if (error) setError(null)
          }}
          placeholder="Paste Solana wallet address"
          placeholderTextColor={muted}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={onSubmit}
          editable={!track.isPending}
          accessibilityLabel="Wallet address to track"
          style={{
            color: ink,
            backgroundColor: surface,
            borderWidth: 1,
            borderColor: error ? danger : border,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 14,
            fontSize: 15,
          }}
        />
        {error ? (
          <AppText selectable accessibilityLiveRegion="polite" style={{ color: danger, fontSize: 13 }}>
            {error}
          </AppText>
        ) : null}
      </View>
      <AppButton title="Track wallet" busy={track.isPending} disabled={!address.trim()} onPress={onSubmit} />
    </View>
  )
}
