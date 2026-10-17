import { Button } from '@react-navigation/elements'
import { PublicKey } from '@solana/web3.js'
import type { PaymentAsset } from '@waffle/shared'
import { useState } from 'react'
import { ActivityIndicator, Alert, TextInput, View } from 'react-native'
import { useTransferAsset } from '@/components/account/use-transfer-asset'
import { AppExternalLink } from '@/components/app-external-link'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useCluster } from '@/components/cluster/cluster-provider'
import { PaymentAssetPicker } from '@/components/trade/payment-asset-picker'
import { useThemeColor } from '@/hooks/use-theme-color'

export function AccountFeatureSend({ address }: { address: PublicKey }) {
  const transferSol = useTransferAsset({ address })
  const [asset, setAsset] = useState<PaymentAsset>('SOL')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const { selectedCluster, getExplorerUrl } = useCluster()
  const [destinationAddress, setDestinationAddress] = useState('')
  const [amount, setAmount] = useState('')
  const backgroundColor = useThemeColor({ light: '#f0f0f0', dark: '#333333' }, 'background')
  const textColor = useThemeColor({ light: '#000000', dark: '#ffffff' }, 'text')

  return (
    <AppView>
      <AppText type="subtitle">
        Send {asset} on {selectedCluster.name} from the connected wallet.
      </AppText>
      <PaymentAssetPicker
        value={asset}
        onChange={(next) => {
          setAsset(next)
          setAmount('')
        }}
        disabled={transferSol.isPending || submitted !== null}
      />
      <AppText>SOL is required for network fees and any recipient token account rent.</AppText>
      {submitted ? (
        <>
          <AppText selectable>Transfer submitted. Check its outcome before sending again.</AppText>
          <AppExternalLink href={getExplorerUrl(`tx/${submitted}`)}>
            <AppText type="link">View transaction</AppText>
          </AppExternalLink>
        </>
      ) : null}
      {transferSol.isPending ? (
        <ActivityIndicator />
      ) : (
        <View style={{ gap: 16 }}>
          <AppText>Amount ({asset})</AppText>
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
            disabled={transferSol.isPending || submitted !== null}
            onPress={async () => {
              try {
                const destination = new PublicKey(destinationAddress)
                await transferSol.mutateAsync({ amount, destination, asset, onSubmitted: setSubmitted })
                setAmount('')
                setSubmitted(null)
                Alert.alert('Transfer confirmed', `Sent ${amount} ${asset} to ${destinationAddress}`)
              } catch (error) {
                Alert.alert(
                  'Check transfer',
                  error instanceof Error ? error.message : 'Check your wallet before trying again.',
                )
              }
            }}
            variant="filled"
          >
            Send {asset}
          </Button>
        </View>
      )}
      {transferSol.isError ? (
        <AppText style={{ color: 'red', fontSize: 12 }}>{`${transferSol.error.message}`}</AppText>
      ) : null}
    </AppView>
  )
}
