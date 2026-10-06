import { router } from 'expo-router'
import { View } from 'react-native'
import { ClusterNetwork } from '@/components/cluster/cluster-network'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppButton } from '@/components/ui/app-button'

export function AccountUiButtons() {
  const { selectedCluster } = useCluster()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <AppButton title="Send" variant="secondary" onPress={() => router.push('/account/send')} />
      <AppButton title="Receive" variant="secondary" onPress={() => router.push('/account/receive')} />
      {selectedCluster.network !== ClusterNetwork.Mainnet ? (
        <AppButton title="Airdrop" variant="quiet" onPress={() => router.push('/account/airdrop')} />
      ) : null}
    </View>
  )
}
