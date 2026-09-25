import { useQuery } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { AppText } from '@/components/app-text'
import type { Cluster } from '@/components/cluster/cluster'
import { ellipsify } from '@/utils/ellipsify'

export function ClusterUiGenesisHash({ selectedCluster }: { selectedCluster: Cluster }) {
  const { connection } = useMobileWallet()
  const query = useQuery({
    queryKey: ['get-genesis-hash', { selectedCluster }],
    queryFn: () => connection.getGenesisHash(),
  })

  return <AppText>Genesis Hash: {query.isLoading ? 'Loading...' : `${ellipsify(query.data, 8)}`}</AppText>
}
