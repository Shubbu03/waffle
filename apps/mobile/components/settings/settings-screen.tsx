import { Platform, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useCluster } from '@/components/cluster/cluster-provider'
import { SettingsDropdown, SettingsGroup, SettingsRow } from '@/components/settings/settings-ui'
import { SettingsUiAccount } from '@/components/settings/settings-ui-account'
import { SettingsUiNotifications } from '@/components/settings/settings-ui-notifications'
import { SettingsUiTheme } from '@/components/settings/settings-ui-theme'

export function SettingsScreen() {
  const { selectedCluster, clusters, setSelectedCluster } = useCluster()
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 20, paddingBottom: 28, gap: 24 }}
        >
          <AppText type="title">Settings</AppText>
          <SettingsUiAccount />
          <SettingsGroup title="Preferences">
            <SettingsUiTheme />
            <SettingsRow
              title="Network"
              detail={
                selectedCluster.id === 'solana:devnet'
                  ? 'Test SOL · PumpSwap trades on Devnet'
                  : selectedCluster.id === 'solana:testnet'
                    ? 'Account access available. PumpSwap trading is not deployed on Testnet.'
                    : undefined
              }
            >
              <SettingsDropdown
                label="Network"
                value={selectedCluster.name}
                options={clusters.map((cluster) => ({
                  label: cluster.name,
                  value: cluster.id,
                  select: () => setSelectedCluster(cluster),
                }))}
              />
            </SettingsRow>
            {Platform.OS === 'android' ? <SettingsUiNotifications /> : null}
          </SettingsGroup>
        </ScrollView>
      </SafeAreaView>
    </AppView>
  )
}
