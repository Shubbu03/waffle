import { Button } from '@react-navigation/elements'
import { PublicKey } from '@solana/web3.js'
import { useState } from 'react'
import { ActivityIndicator, Alert, TextInput, View } from 'react-native'
import { useTransferSol } from '@/components/account/use-transfer-sol'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useCluster } from '@/components/cluster/cluster-provider'
import { useThemeColor } from '@/hooks/use-theme-color'

export function AccountFeatureSend({ address }: { address: PublicKey }) {
  const transferSol = useTransferSol({ address })
  const { selectedCluster } = useCluster()
  const [destinationAddress, setDestinationAddress] = useState('')
  const [amount, setAmount] = useState('')
  const backgroundColor = useThemeColor({ light: '#f0f0f0', dark: '#333333' }, 'background')
  const textColor = useThemeColor({ light: '#000000', dark: '#ffffff' }, 'text')

  return (
    <AppView>
      <AppText type="subtitle">Send SOL on {selectedCluster.name} from the connected wallet.</AppText>
      {transferSol.isPending ? (
        <ActivityIndicator />
      ) : (
        <View style={{ gap: 16 }}>
          <AppText>Amount (SOL)</AppText>
          <TextInput
            style={{
              backgroundColor,
              color: textColor,
              borderWidth: 1,
              borderRadius: 25,
              paddingHorizontal: 16,
            }}
            value={amount}
            onChangeText={setAmount}
            keyboardType="numeric"
          />
          <AppText>Destination Address</AppText>
          <TextInput
            style={{
              backgroundColor,
              color: textColor,
              borderWidth: 1,
              borderRadius: 25,
              paddingHorizontal: 16,
            }}
            value={destinationAddress}
            onChangeText={setDestinationAddress}
          />

          <Button
            disabled={transferSol.isPending}
            onPress={async () => {
              try {
                const destination = new PublicKey(destinationAddress)
                await transferSol.mutateAsync({ amount: Number(amount), destination })
                Alert.alert('Transfer confirmed', `Sent ${amount} SOL to ${destinationAddress}`)
              } catch (error) {
                Alert.alert('Transfer failed', error instanceof Error ? error.message : 'Please try again.')
              }
            }}
            variant="filled"
          >
            Send SOL
          </Button>
        </View>
      )}
      {transferSol.isError ? (
        <AppText style={{ color: 'red', fontSize: 12 }}>{`${transferSol.error.message}`}</AppText>
      ) : null}
    </AppView>
  )
}
