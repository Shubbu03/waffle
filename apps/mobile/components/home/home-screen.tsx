import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { HomeActivityRow, HomeWatchlistRow } from '@/components/home/home-overview-rows'
import { HomeWalletMenu } from '@/components/home/home-wallet-menu'
import { useSignalClock, useSignalFeed } from '@/components/signals/use-signals'
import { AppButton } from '@/components/ui/app-button'
import { ConnectionState } from '@/components/ui/connection-state'
import { useWalletSubscriptions } from '@/components/wallets/use-wallets'
import { FontFamily } from '@/constants/fonts'
import { useThemeColor } from '@/hooks/use-theme-color'
import { signalWallets } from '@/lib/signal-wallets'

export function HomeScreen() {
  const { session, serverLinked, status } = useAuth()
  const subscriptions = useWalletSubscriptions()
  // Unknown follows stay personal until resolved; a failed read must never mean "no follows".
  const view = session && subscriptions.data?.length !== 0 ? 'following' : 'all'
  const feed = useSignalFeed(view)
  const now = useSignalClock()
  const [refreshing, setRefreshing] = useState(false)
  const muted = useThemeColor({}, 'muted')
  const surface = useThemeColor({}, 'surface')
  const watchlist = session
    ? signalWallets(feed.catalog, view === 'following' ? feed.items : [], 'following', feed.subscribedWalletIds)
    : []
  const preview = watchlist.slice(0, 3)
  const followed = feed.subscribedWalletIds === null ? null : new Set(feed.subscribedWalletIds)
  const activity = (
    view === 'following' && followed ? feed.items.filter((signal) => followed.has(signal.walletId)) : feed.items
  ).slice(0, 3)
  const offline =
    feed.status === 'cached' || !feed.fetchedAt || now - feed.fetchedAt > 45_000 || feed.connection === 'paused'
  const watchlistLoading =
    status === 'loading' ||
    (serverLinked &&
      (subscriptions.isPending ||
        (view === 'following' && feed.catalogLoading && !preview.length && !subscriptions.isError)))
  const watchlistError = Boolean(session) && (subscriptions.isError || (view === 'following' && feed.catalogError))
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.allSettled([feed.refresh(), ...(serverLinked && view === 'all' ? [subscriptions.refetch()] : [])])
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 28, gap: 20 }}
          refreshControl={
            <RefreshControl refreshing={refreshing || feed.refreshing} onRefresh={() => void refresh()} />
          }
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
            <View style={{ gap: 8 }}>
              <SectionTitle
                title="Your watchlist"
                action={preview.length ? 'Manage' : undefined}
                onPress={() => router.push('/wallets')}
              />
              {preview.length ? (
                <View style={{ backgroundColor: surface, borderRadius: 20, paddingHorizontal: 16, overflow: 'hidden' }}>
                  {preview.map((wallet, index) => (
                    <HomeWatchlistRow key={wallet.id} wallet={wallet} now={now} last={index === preview.length - 1} />
                  ))}
                </View>
              ) : watchlistLoading ? (
                <LoadingRow title="Loading your watchlist…" />
              ) : session && !serverLinked ? (
                <View style={{ gap: 12, paddingVertical: 12 }}>
                  <AppText style={{ color: muted, fontSize: 13 }}>Reconnect to load your watchlist.</AppText>
                  <AppButton
                    title="Verify account"
                    variant="secondary"
                    onPress={() => router.push('/sign-in')}
                    style={{ alignSelf: 'flex-start' }}
                  />
                </View>
              ) : watchlistError || (session && subscriptions.data?.length) ? (
                <ConnectionState
                  title="Unable to load your watchlist"
                  message="Pull down to retry."
                  retry={() => void refresh()}
                  busy={refreshing}
                />
              ) : (
                <View style={{ gap: 14, paddingVertical: 12 }}>
                  <AppText style={{ color: muted, fontSize: 14 }}>Follow wallets to see their activity here.</AppText>
                  <AppButton
                    title="Choose wallets"
                    onPress={() => router.push('/wallets')}
                    style={{ alignSelf: 'flex-start' }}
                  />
                </View>
              )}
              {preview.length > 0 && watchlistError ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Showing saved wallets · pull down to retry</AppText>
              ) : preview.length > 0 && !serverLinked ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Saved watchlist · offline</AppText>
              ) : null}
            </View>
            <View style={{ gap: 8 }}>
              <SectionTitle
                title={view === 'following' ? 'Recent activity' : 'Public activity'}
                action="View all"
                onPress={() => router.push({ pathname: '/(tabs)/signals', params: { view } })}
              />
              {activity.length ? (
                <View style={{ backgroundColor: surface, borderRadius: 20, paddingHorizontal: 16, overflow: 'hidden' }}>
                  {activity.map((signal, index) => (
                    <HomeActivityRow
                      key={signal.id}
                      signal={signal}
                      walletName={feed.catalog.find((wallet) => wallet.id === signal.walletId)?.label}
                      now={now}
                      offline={offline}
                      last={index === activity.length - 1}
                    />
                  ))}
                </View>
              ) : feed.waitingForSession ? (
                <AppText style={{ color: muted, fontSize: 13, paddingVertical: 12 }}>
                  Your activity will return when you reconnect.
                </AppText>
              ) : feed.followingError ? (
                <AppText style={{ color: muted, fontSize: 13, paddingVertical: 12 }}>
                  Activity is unavailable until your watchlist loads.
                </AppText>
              ) : feed.status === 'loading' || feed.subscriptionsLoading ? (
                <LoadingRow title="Loading activity…" />
              ) : feed.status === 'error' ? (
                <ConnectionState
                  title="Unable to load activity"
                  message="Pull down to retry."
                  retry={() => void refresh()}
                  busy={refreshing}
                />
              ) : (
                <AppText style={{ color: muted, fontSize: 13, paddingVertical: 12 }}>
                  {view === 'following' ? 'New buys from your wallets will appear here.' : 'No public activity yet.'}
                </AppText>
              )}
              {activity.length > 0 && offline ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Saved activity · may be out of date</AppText>
              ) : activity.length > 0 && (feed.error || feed.followingError) ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Couldn’t refresh activity · pull down to retry</AppText>
              ) : null}
              {feed.historyGap ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Some older activity is no longer available.</AppText>
              ) : null}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </AppView>
  )
}

function SectionTitle({ title, action, onPress }: { title: string; action?: string; onPress: () => void }) {
  return (
    <View
      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 44 }}
    >
      <AppText type="subtitle" style={{ flex: 1, fontSize: 18 }}>
        {title}
      </AppText>
      {action ? (
        <AppButton
          title={action}
          variant="quiet"
          onPress={onPress}
          style={{ minHeight: 44, paddingHorizontal: 4, paddingVertical: 10 }}
        />
      ) : null}
    </View>
  )
}

function LoadingRow({ title }: { title: string }) {
  const muted = useThemeColor({}, 'muted')
  const ink = useThemeColor({}, 'text')
  return (
    <View style={{ minHeight: 88, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <ActivityIndicator color={ink} />
      <AppText style={{ color: muted, fontSize: 13 }}>{title}</AppText>
    </View>
  )
}
