import { clusterApiUrl } from '@solana/web3.js'
import type { Cluster } from '@/components/cluster/cluster'
import { ClusterNetwork } from '@/components/cluster/cluster-network'

let apiRoot = process.env.EXPO_PUBLIC_WAFFLE_API_URL?.trim().replace(/\/+$/, '') ?? ''

export const apiRootUrl = () => apiRoot

export const AppConfig: {
  name: string
  uri: string
  apiUrl: string
  network: 'mainnet' | 'devnet' | 'testnet'
  clusters: Cluster[]
} = {
  name: 'waffle',
  uri: process.env.EXPO_PUBLIC_WAFFLE_APP_URI?.trim() ?? '',
  network: 'mainnet',
  get apiUrl() {
    return AppConfig.network === 'mainnet' || !apiRoot ? apiRoot : `${apiRoot}/networks/${AppConfig.network}`
  },
  set apiUrl(value: string) {
    apiRoot = value.replace(/\/+$/, '')
  },
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
      endpoint: process.env.EXPO_PUBLIC_SOLANA_DEVNET_RPC_URL ?? clusterApiUrl('devnet'),
      network: ClusterNetwork.Devnet,
    },
    {
      id: 'solana:testnet',
      name: 'Testnet',
      endpoint: process.env.EXPO_PUBLIC_SOLANA_TESTNET_RPC_URL ?? clusterApiUrl('testnet'),
      network: ClusterNetwork.Testnet,
    },
  ],
}
