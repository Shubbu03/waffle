import { Link } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { SignalCard } from '@/components/signals/signal-card'
import { useSignalClock, useSignalFeed } from '@/components/signals/use-signals'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ageLabel, type SignalView } from '@/lib/signal-state'

export function SignalFeedScreen() {
  const [view, setView] = useState<SignalView>('all')
  const { session, status } = useAuth()
  const feed = useSignalFeed(view)
  const now = useSignalClock()
  const ink = useThemeColor({}, 'text')
  const background = useThemeColor({}, 'background')
  const offline =
    feed.status === 'cached' || feed.connection === 'paused' || !feed.fetchedAt || now - feed.fetchedAt > 45_000
  const labels = new Map(feed.catalog.map((wallet) => [wallet.id, wallet.label]))
  const needsSignIn = view === 'following' && !session
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={{ padding: 20, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <AppText type="title">Signals</AppText>
            {!session ? (
              <Link href="/sign-in">
                <AppText type="link">Sign in</AppText>
              </Link>
            ) : null}
          </View>
          <AppText style={{ opacity: 0.7 }}>Watch the moves. Read the reasons.</AppText>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['all', 'following'] as const).map((item) => (
              <Pressable
                key={item}
                accessibilityRole="button"
                accessibilityState={{ selected: view === item }}
                onPress={() => setView(item)}
                style={{
                  flex: 1,
                  borderWidth: 1.5,
                  borderColor: ink,
                  borderRadius: 14,
                  padding: 12,
                  backgroundColor: view === item ? ink : background,
                  alignItems: 'center',
                }}
              >
                <AppText
                  lightColor={view === item ? background : ink}
                  darkColor={view === item ? background : ink}
                  type="defaultSemiBold"
                >
                  {item === 'all' ? 'All signals' : 'Following'}
                </AppText>
              </Pressable>
            ))}
          </View>
        </View>
        {needsSignIn ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 }}>
            <AppText type="subtitle">Your follows, in one feed.</AppText>
            <AppText style={{ textAlign: 'center' }}>
              {status === 'loading' ? 'Restoring your session…' : 'Sign in to see signals from wallets you follow.'}
            </AppText>
            <Link href="/sign-in">
              <AppText type="link">Connect wallet</AppText>
            </Link>
          </View>
        ) : (
          <FlatList
            data={feed.items}
            keyExtractor={(item) => item.id}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 12, flexGrow: 1 }}
            refreshing={feed.refreshing}
            onRefresh={() => void feed.refresh()}
            renderItem={({ item }) => (
              <SignalCard signal={item} label={labels.get(item.walletId)} offline={offline} now={now} />
            )}
            ListHeaderComponent={
              <View style={{ gap: 8, paddingBottom: 8 }}>
                <AppText style={{ fontSize: 13, opacity: 0.7 }} accessibilityLiveRegion="polite">
                  {offline
                    ? 'Cached browsing · copying unavailable'
                    : feed.connection === 'live'
                      ? 'Live updates connected'
                      : 'Live updates reconnecting · periodic refresh active'}
                  {feed.fetchedAt ? ` · checked ${ageLabel(new Date(feed.fetchedAt).toISOString(), now)}` : ''}
                </AppText>
                {feed.waitingForSession ? (
                  <AppText>API session offline. Cached Following remains available.</AppText>
                ) : null}
                {feed.historyGap ? (
                  <AppText>Some older events are no longer available. Recent history has been reloaded.</AppText>
                ) : null}
                {feed.error || feed.followingError ? (
                  <AppText selectable>{feed.error ?? feed.followingError}</AppText>
                ) : null}
              </View>
            }
            ListEmptyComponent={
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 32, gap: 12 }}>
                {feed.status === 'loading' ? (
                  <>
                    <ActivityIndicator />
                    <AppText>Loading signals…</AppText>
                  </>
                ) : (
                  <>
                    <AppText type="subtitle">
                      {feed.status === 'error' ? 'Signals unavailable' : 'No signals yet'}
                    </AppText>
                    <AppText style={{ textAlign: 'center' }}>
                      {view === 'following'
                        ? 'Follow an active wallet to see its supported buys here.'
                        : 'Supported wallet buys will appear here with their checks.'}
                    </AppText>
                    {view === 'following' ? (
                      <Link href="/(tabs)/wallets">
                        <AppText type="link">Browse wallets</AppText>
                      </Link>
                    ) : null}
                    <Pressable accessibilityRole="button" onPress={() => void feed.refresh()}>
                      <AppText type="link">Retry</AppText>
                    </Pressable>
                  </>
                )}
              </View>
            }
            ListFooterComponent={
              feed.hasMore ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={feed.loadingMore || offline}
                  onPress={() => void feed.loadMore()}
                  style={{ padding: 16, alignItems: 'center' }}
                >
                  {feed.loadingMore ? (
                    <ActivityIndicator />
                  ) : (
                    <AppText type="link">{offline ? 'Reconnect to load older signals' : 'Load older signals'}</AppText>
                  )}
                </Pressable>
              ) : null
            }
          />
        )}
      </SafeAreaView>
    </AppView>
  )
}
