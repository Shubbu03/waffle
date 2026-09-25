import { Button } from '@react-navigation/elements'
import type { PublicKey } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { ActivityIndicator } from 'react-native'
import { useRequestAirdrop } from '@/components/account/use-request-airdrop'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { ClusterNetwork } from '@/components/cluster/cluster-network'
import { useCluster } from '@/components/cluster/cluster-provider'

export function AccountFeatureAirdrop({ back }: { back: () => void }) {
  const { account } = useMobileWallet()
  const { selectedCluster } = useCluster()
  const amount = 1
  const requestAirdrop = useRequestAirdrop({ address: account?.address as PublicKey })

  if (selectedCluster.network === ClusterNetwork.Mainnet) {
    return <AppText>Airdrops are unavailable on mainnet.</AppText>
  }

  return (
    <AppView>
      <AppText type="subtitle">Request a 1 SOL airdrop to the connected wallet.</AppText>
      {requestAirdrop.isPending ? (
        <ActivityIndicator />
      ) : (
        <Button
          disabled={requestAirdrop.isPending}
          onPress={() => {
            requestAirdrop
              .mutateAsync(amount)
              .then(() => {
                console.log(`Requested airdrop of ${amount} SOL to ${account?.address}`)
                back()
              })
              .catch((err) => console.log(`Error requesting airdrop: ${err}`, err))
          }}
          variant="filled"
        >
          Request Airdrop
        </Button>
      )}
      {requestAirdrop.isError ? (
        <AppText style={{ color: 'red', fontSize: 12 }}>{`${requestAirdrop.error.message}`}</AppText>
      ) : null}
    </AppView>
  )
}
