import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { useState } from 'react'
import { Alert, Platform } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppButton } from '@/components/ui/app-button'

export function WalletUiButtonConnect({ label = 'Connect' }: { label?: string }) {
  const { connect } = useMobileWallet()
  const [busy, setBusy] = useState(false)
  if (Platform.OS !== 'android') return <AppText>Reconnect your wallet on Android.</AppText>
  return (
    <AppButton
      title={label}
      busy={busy}
      onPress={() => {
        setBusy(true)
        void connect()
          .catch((error: unknown) =>
            Alert.alert('Wallet connection failed', error instanceof Error ? error.message : 'Please try again.'),
          )
          .finally(() => setBusy(false))
      }}
    />
  )
}
