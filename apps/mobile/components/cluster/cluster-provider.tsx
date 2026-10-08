import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Cluster } from '@/components/cluster/cluster'
import { ClusterNetwork } from '@/components/cluster/cluster-network'
import { AppConfig } from '@/constants/app-config'

export interface ClusterProviderContext {
  apiUrl: string
  selectedCluster: Cluster
  clusters: Cluster[]
  setSelectedCluster: (cluster: Cluster) => void

  getExplorerUrl(path: string): `https://${string}`
}

const Context = createContext<ClusterProviderContext>({} as ClusterProviderContext)

export function ClusterProvider({ children }: { children: ReactNode }) {
  const [selectedCluster, updateCluster] = useState<Cluster>(AppConfig.clusters[0])
  const selectionChanged = useRef(false)
  useEffect(() => {
    let active = true
    void AsyncStorage.getItem('waffle.network.v1')
      .then((id) => {
        const cluster = AppConfig.clusters.find((item) => item.id === id)
        if (active && !selectionChanged.current && cluster) {
          AppConfig.network = cluster.id.replace('solana:', '') as typeof AppConfig.network
          updateCluster(cluster)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  const value: ClusterProviderContext = useMemo(
    () => ({
      selectedCluster,
      apiUrl: AppConfig.apiUrl,
      clusters: [...AppConfig.clusters].sort((a, b) => (a.name > b.name ? 1 : -1)),
      setSelectedCluster: (cluster: Cluster) => {
        selectionChanged.current = true
        if (!['solana:mainnet', 'solana:devnet', 'solana:testnet'].includes(cluster.id)) return
        AppConfig.network = cluster.id.replace('solana:', '') as typeof AppConfig.network
        updateCluster(cluster)
        void AsyncStorage.setItem('waffle.network.v1', cluster.id).catch(() => {})
      },
      getExplorerUrl: (path: string) => `https://explorer.solana.com/${path}${getClusterUrlParam(selectedCluster)}`,
    }),
    [selectedCluster],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useCluster() {
  return useContext(Context)
}

function getClusterUrlParam(cluster: Cluster): string {
  let suffix = ''
  switch (cluster.network) {
    case ClusterNetwork.Devnet:
      suffix = 'devnet'
      break
    case ClusterNetwork.Mainnet:
      suffix = ''
      break
    case ClusterNetwork.Testnet:
      suffix = 'testnet'
      break
    default:
      suffix = `custom&customUrl=${encodeURIComponent(cluster.endpoint)}`
      break
  }

  return suffix.length ? `?cluster=${suffix}` : ''
}
