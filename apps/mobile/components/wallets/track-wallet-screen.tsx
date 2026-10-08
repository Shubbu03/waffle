import { router } from 'expo-router'
import { useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Alert, Keyboard, Pressable, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppButton } from '@/components/ui/app-button'
import { useTrackWallet } from '@/components/wallets/use-wallets'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ApiError } from '@/lib/api-error'
import { checkWalletAddress, trackErrorMessage } from '@/lib/wallet-validation'

/** Content-sized native sheet; avoid flex: 1 so Android can measure its height. */
export function TrackWalletScreen() {
  const { selectedCluster } = useCluster()
  const { session, serverLinked, status } = useAuth()
  const insets = useSafeAreaInsets()
  const ink = useThemeColor({}, 'text')
  const background = useThemeColor({}, 'surface')
  const close = () => {
    Keyboard.dismiss()
    router.back()
  }
  return (
    <View
      collapsable={false}
      style={{ backgroundColor: background, padding: 20, paddingBottom: Math.max(insets.bottom, 20), gap: 14 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText type="subtitle">Track wallet</AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close add wallet"
          onPress={close}
          hitSlop={8}
          style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }}
        >
          <AppText style={{ fontSize: 14 }}>Close</AppText>
        </Pressable>
      </View>
      <AppText style={{ fontSize: 13 }}>Track on {selectedCluster.name}</AppText>
      {status === 'loading' ? (
        <ActivityIndicator color={ink} />
      ) : !session || !serverLinked ? (
        <View style={{ gap: 14 }}>
          <AppText>{session ? 'Reconnect your account to track a wallet.' : 'Sign in to track a wallet.'}</AppText>
          <AppButton
            title={session ? 'Verify account' : 'Sign in with wallet'}
            onPress={() => {
              Keyboard.dismiss()
              router.replace('/sign-in')
            }}
          />
        </View>
      ) : (
        <TrackWalletForm onAdded={close} />
      )}
    </View>
  )
}

function TrackWalletForm({ onAdded }: { onAdded: () => void }) {
  const track = useTrackWallet()
  const ink = useThemeColor({}, 'text')
  const surface = useThemeColor({}, 'background')
  const border = useThemeColor({}, 'border')
  const muted = useThemeColor({}, 'muted')
  const danger = useThemeColor({}, 'danger')
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
        onSuccess: (result) => {
          AccessibilityInfo.announceForAccessibility('Wallet added to Following')
          onAdded()
          if (result.veryActive) {
            Alert.alert('Wallet added', 'This wallet is very active, so signals may lag behind.')
          }
        },
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
  return (
    <View style={{ gap: 14 }}>
      <AppText style={{ color: muted, fontSize: 13 }}>Add up to 3 wallets to Following.</AppText>
      <View style={{ gap: 8 }}>
        <TextInput
          value={address}
          onChangeText={(value) => {
            setAddress(value)
            if (error) setError(null)
          }}
          placeholder="Paste Solana wallet address"
          placeholderTextColor={muted}
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
