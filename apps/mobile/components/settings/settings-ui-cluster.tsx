import { AppDropdown } from '@/components/app-dropdown'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { ClusterUiGenesisHash } from '@/components/cluster/cluster-ui-genesis-hash'
import { ClusterUiVersion } from '@/components/cluster/cluster-ui-version'
import { useCluster } from '../cluster/cluster-provider'

export function SettingsUiCluster() {
  const { selectedCluster, clusters, setSelectedCluster } = useCluster()
  return (
    <AppView>
      <AppText type="subtitle">Cluster</AppText>
      <ClusterUiVersion selectedCluster={selectedCluster} />
      <ClusterUiGenesisHash selectedCluster={selectedCluster} />
      <AppDropdown
        items={clusters.map((c) => c.name)}
        selectedItem={selectedCluster.name}
        selectItem={(name) => {
          const cluster = clusters.find((c) => c.name === name)
          if (cluster) setSelectedCluster(cluster)
        }}
      />
    </AppView>
  )
}
