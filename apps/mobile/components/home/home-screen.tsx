import { router } from 'expo-router'
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { HomeWalletMenu } from '@/components/home/home-wallet-menu'
import { SignalCard } from '@/components/signals/signal-card'
import { useSignalClock, useSignalFeed } from '@/components/signals/use-signals'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { ConnectionState } from '@/components/ui/connection-state'
import { useWalletRows } from '@/components/wallets/use-wallets'
import { FontFamily } from '@/constants/fonts'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ellipsify } from '@/utils/ellipsify'

export function HomeScreen() {
  const { serverLinked } = useAuth()
  const feed = useSignalFeed('all')
  const { rows, catalog, subscriptions } = useWalletRows()
  const now = useSignalClock()
  const muted = useThemeColor({}, 'muted')
  const accent = useThemeColor({}, 'accentSoft')
  const offline =
    feed.status === 'cached' || !feed.fetchedAt || now - feed.fetchedAt > 45_000 || feed.connection === 'paused'
  const refresh = () => {
    void feed.refresh()
    void catalog.refetch()
    if (serverLinked) void subscriptions.refetch()
  }
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView
          contentContainerStyle={{ paddingBottom: 28, gap: 22 }}
          refreshControl={<RefreshControl refreshing={feed.refreshing || catalog.isRefetching} onRefresh={refresh} />}
        >
          <View
            style={{
              paddingHorizontal: 20,
              paddingTop: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <AppText style={{ fontFamily: FontFamily.wordmark, fontSize: 23, lineHeight: 44 }}>waffle</AppText>
            <HomeWalletMenu />
          </View>
          <View style={{ paddingHorizontal: 20, gap: 24 }}>
            <View style={{ gap: 12 }}>
              <SectionTitle title="Recent signals" action="View all" onPress={() => router.push('/(tabs)/signals')} />
              {feed.items.slice(0, 2).map((signal) => (
                <SignalCard
                  key={signal.id}
                  signal={signal}
                  label={rows.find((row) => row.id === signal.walletId)?.label}
                  now={now}
                  offline={offline}
                />
              ))}
              {feed.status === 'loading' && !feed.items.length ? (
                <AppCard>
                  <ActivityIndicator />
                  <AppText style={{ color: muted, textAlign: 'center' }}>Loading signals…</AppText>
                </AppCard>
              ) : null}
              {feed.status === 'error' && !feed.items.length ? (
                <ConnectionState
                  title="Unable to load signals"
                  message="Try again in a moment."
                  retry={() => void feed.refresh()}
                  busy={feed.refreshing}
                />
              ) : null}
              {feed.status === 'cached' ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Offline · showing saved signals</AppText>
              ) : null}
              {feed.status === 'ready' && !feed.items.length ? (
                <AppCard>
                  <AppText style={{ color: muted }}>No signals yet.</AppText>
                </AppCard>
              ) : null}
            </View>
            <View style={{ gap: 12 }}>
              <SectionTitle title="Tracked wallets" action="View all" onPress={() => router.push('/wallets')} />
              {catalog.isPending ? (
                <AppCard>
                  <ActivityIndicator />
                  <AppText style={{ color: muted }}>Loading wallets…</AppText>
                </AppCard>
              ) : catalog.isError && !rows.length ? (
                <ConnectionState
                  title="Unable to load wallets"
                  message="Try again in a moment."
                  retry={() => void catalog.refetch()}
                  busy={catalog.isFetching}
                />
              ) : (
                <AppCard>
                  {rows.slice(0, 3).map((row) => (
                    <View key={row.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 14,
                          backgroundColor: accent,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <AppText type="defaultSemiBold">{row.label.slice(0, 1)}</AppText>
                      </View>
                      <View style={{ flex: 1 }}>
                        <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
                          {row.label}
                        </AppText>
                        <AppText style={{ color: muted, fontSize: 12 }}>
                          {ellipsify(row.address, 5)}
                          {!row.active ? ' · Paused' : ''}
                          {row.followed ? ' · Following' : ''}
                        </AppText>
                      </View>
                    </View>
                  ))}
                  {!rows.length ? <AppText style={{ color: muted }}>No wallets available.</AppText> : null}
                </AppCard>
              )}
              {catalog.isError && rows.length > 0 ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Saved wallets · refresh failed</AppText>
              ) : null}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </AppView>
  )
}
function SectionTitle({ title, action, onPress }: { title: string; action: string; onPress: () => void }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <AppText type="subtitle" style={{ flex: 1, fontSize: 18 }}>
        {title}
      </AppText>
      <AppButton title={action} variant="quiet" onPress={onPress} />
    </View>
  )
}
