import { Button } from '@react-navigation/elements'
import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { ClusterNetwork } from '@/components/cluster/cluster-network'
import { useCluster } from '@/components/cluster/cluster-provider'

export function AccountUiButtons() {
  const router = useRouter()
  const { selectedCluster } = useCluster()
  return (
    <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
      {selectedCluster.network !== ClusterNetwork.Mainnet ? (
        <Button onPressIn={() => router.navigate('/(tabs)/account/airdrop')}>Airdrop</Button>
      ) : null}
      <Button onPressIn={() => router.navigate('/(tabs)/account/send')}>Send</Button>
      <Button onPressIn={() => router.navigate('/(tabs)/account/receive')}>Receive</Button>
    </View>
  )
}
