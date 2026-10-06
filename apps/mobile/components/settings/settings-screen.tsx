import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { Linking, Platform, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { useCluster } from '@/components/cluster/cluster-provider'
import { usePush } from '@/components/push/push-provider'
import { SettingsUiAccount } from '@/components/settings/settings-ui-account'
import { SettingsUiTheme } from '@/components/settings/settings-ui-theme'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { checkApiConnection } from '@/lib/api-client'

export function SettingsScreen() {
  const { session } = useAuth()
  const push = usePush()
  const { selectedCluster, clusters, setSelectedCluster } = useCluster()
  const muted = useThemeColor({}, 'muted')
  const danger = useThemeColor({}, 'danger')
  const health = useQuery({
    queryKey: ['api-health', AppConfig.apiUrl],
    queryFn: async ({ signal }) => {
      await checkApiConnection(signal)
      return true
    },
    enabled: false,
    retry: false,
  })
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 32, gap: 22 }}>
          <View style={{ gap: 8 }}>
            <AppText type="title">Settings</AppText>
            <AppText style={{ color: muted, fontSize: 14 }}>Your account, network, and connection.</AppText>
          </View>
          <AppCard>
            <SettingsUiAccount />
          </AppCard>
          <AppCard>
            <SettingsUiTheme />
          </AppCard>
          {session && Platform.OS === 'android' ? (
            <AppCard>
              <AppText type="subtitle">Notifications</AppText>
              <AppText style={{ color: muted, fontSize: 14 }} accessibilityLiveRegion="polite">
                {push.permission === 'denied'
                  ? 'Notifications are off in Android settings.'
                  : push.registrationUnavailable
                    ? 'Unable to connect alerts. Retrying automatically.'
                    : push.isRegistering || push.permission === 'checking'
                      ? 'Connecting alerts…'
                      : 'Alerts are ready. Enable them for wallets you follow.'}
              </AppText>
              <AppButton
                title={push.permission === 'denied' ? 'Open notification settings' : 'Retry connection'}
                variant="secondary"
                busy={push.isRegistering}
                onPress={push.permission === 'denied' ? () => void Linking.openSettings() : push.retryRegistration}
              />
            </AppCard>
          ) : null}
          <AppCard>
            <AppText type="subtitle">Your activity</AppText>
            <AppButton title="My wallet →" variant="secondary" onPress={() => router.push('/account')} />
            <AppButton
              title="Paper positions · simulated →"
              variant="secondary"
              onPress={() => router.push('/paper/positions')}
            />
          </AppCard>
          <AppCard>
            <AppText type="subtitle">Network</AppText>
            <AppText style={{ color: muted, fontSize: 13 }}>
              Signals track Solana Mainnet. Wallet sign-in requires Mainnet.
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {clusters.map((cluster) => (
                <AppButton
                  key={cluster.id}
                  title={cluster.name}
                  variant={selectedCluster.id === cluster.id ? 'primary' : 'secondary'}
                  onPress={() => setSelectedCluster(cluster)}
                />
              ))}
            </View>
            {selectedCluster.id !== 'solana:mainnet' ? (
              <AppText style={{ color: danger, fontSize: 13 }}>
                Wallet test network selected. Switch to Mainnet to sign in or copy.
              </AppText>
            ) : null}
          </AppCard>
          <AppCard>
            <AppText type="subtitle">Connection</AppText>
            <AppText style={{ color: health.isError ? danger : muted, fontSize: 14 }} accessibilityLiveRegion="polite">
              {health.isFetching
                ? 'Checking waffle…'
                : health.isError
                  ? health.error.message
                  : health.isSuccess
                    ? 'Connected to waffle'
                    : 'Check whether this device can reach waffle.'}
            </AppText>
            <AppButton
              title="Check connection"
              busy={health.isFetching}
              variant="secondary"
              onPress={() => void health.refetch()}
            />
            {__DEV__ ? (
              <View style={{ gap: 8 }}>
                <AppText selectable style={{ color: muted, fontSize: 12 }}>
                  API: {AppConfig.apiUrl || 'not configured'}
                </AppText>
                <AppText style={{ color: muted, fontSize: 12 }}>
                  Start the API on your computer. Physical devices need a reachable LAN address or HTTPS tunnel; an Expo
                  tunnel only serves the app.
                </AppText>
              </View>
            ) : null}
          </AppCard>
          <AppCard>
            <AppText type="subtitle">About waffle</AppText>
            <AppText style={{ color: muted, fontSize: 13 }}>
              Curated wallet activity, transparent signal checks, and paper trading. Scores are checks, not profit
              predictions.
            </AppText>
            {Platform.OS !== 'android' ? (
              <AppText style={{ color: muted, fontSize: 13 }}>
                Public browsing works here. Wallet sign-in and signing use Mobile Wallet Adapter on Android.
              </AppText>
            ) : null}
          </AppCard>
        </ScrollView>
      </SafeAreaView>
    </AppView>
  )
}
