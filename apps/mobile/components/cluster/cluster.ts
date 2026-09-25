import type { SolanaClusterId } from '@wallet-ui/react-native-web3js'
import type { ClusterNetwork } from '@/components/cluster/cluster-network'

export interface Cluster {
  id: SolanaClusterId
  name: string
  endpoint: string
  network: ClusterNetwork
  active?: boolean
}
