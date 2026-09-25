import { clusterApiUrl } from '@solana/web3.js'
import type { Cluster } from '@/components/cluster/cluster'
import { ClusterNetwork } from '@/components/cluster/cluster-network'

export const AppConfig: { name: string; uri: string; clusters: Cluster[] } = {
  name: 'waffle',
  uri: process.env.EXPO_PUBLIC_WAFFLE_APP_URI?.trim() ?? '',
  clusters: [
    {
      id: 'solana:mainnet',
      name: 'Mainnet',
      endpoint: process.env.EXPO_PUBLIC_SOLANA_MAINNET_RPC_URL ?? clusterApiUrl('mainnet-beta'),
      network: ClusterNetwork.Mainnet,
    },
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
