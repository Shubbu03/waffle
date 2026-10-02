import { Alert } from 'react-native'
import { useAuth } from '@/components/auth/auth-provider'
import { BaseButton } from '@/components/solana/base-button'

export function WalletUiButtonDisconnect({ label = 'Disconnect' }: { label?: string }) {
  const { signOut } = useAuth()

  return (
    <BaseButton
      label={label}
      onPress={() => {
        void signOut().catch(() =>
          Alert.alert('Sign-out incomplete', 'Retry to finish clearing secure storage and disconnecting the wallet.'),
        )
      }}
    />
  )
}
