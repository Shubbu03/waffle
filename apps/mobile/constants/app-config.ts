import { clusterApiUrl } from '@solana/web3.js'
import type { Cluster } from '@/components/cluster/cluster'
import { ClusterNetwork } from '@/components/cluster/cluster-network'

export const AppConfig: { name: string; uri: string; clusters: Cluster[] } = {
  name: '/tmp/waffle-template',
  uri: 'https://example.com',
  clusters: [
    {
      id: 'solana:devnet',
      name: 'Devnet',
      endpoint: clusterApiUrl('devnet'),
      network: ClusterNetwork.Devnet,
    },
    {
      id: 'solana:testnet',
      name: 'Testnet',
      endpoint: clusterApiUrl('testnet'),
      network: ClusterNetwork.Testnet,
    },
  ],
}
