import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { SignalCard } from '@/components/signals/signal-card'
import { useSignalClock, useSignalFeed } from '@/components/signals/use-signals'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { ConnectionState } from '@/components/ui/connection-state'
import { ScreenHeading } from '@/components/ui/screen-heading'
import { useThemeColor } from '@/hooks/use-theme-color'
import type { SignalView } from '@/lib/signal-state'

export function SignalFeedScreen() {
  const [view, setView] = useState<SignalView>('all')
  const { session, status } = useAuth()
  const feed = useSignalFeed(view)
  const now = useSignalClock()
  const ink = useThemeColor({}, 'text')
  const surface = useThemeColor({}, 'surfaceMuted')
  const accent = useThemeColor({}, 'accent')
  const accentText = useThemeColor({}, 'accentText')
  const muted = useThemeColor({}, 'muted')
  const offline =
    feed.status === 'cached' || feed.connection === 'paused' || !feed.fetchedAt || now - feed.fetchedAt > 45_000
  const labels = new Map(feed.catalog.map((wallet) => [wallet.id, wallet.label]))
  const needsSignIn = view === 'following' && !session
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <FlatList
          data={needsSignIn ? [] : feed.items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 28, gap: 12, flexGrow: 1 }}
          refreshing={feed.refreshing}
          onRefresh={() => void feed.refresh()}
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: 20 }}>
              <SignalCard signal={item} label={labels.get(item.walletId)} offline={offline} now={now} />
            </View>
          )}
          ListHeaderComponent={
            <View style={{ gap: 12, paddingBottom: 4 }}>
              <ScreenHeading title="Signals" />
              <View style={{ paddingHorizontal: 20, gap: 14 }}>
                <View style={{ flexDirection: 'row', padding: 4, gap: 4, borderRadius: 17, backgroundColor: surface }}>
                  {(['all', 'following'] as const).map((item) => (
                    <Pressable
                      key={item}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: view === item }}
                      onPress={() => setView(item)}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        justifyContent: 'center',
                        alignItems: 'center',
                        borderRadius: 13,
                        padding: 10,
                        backgroundColor: view === item ? accent : 'transparent',
                      }}
                    >
                      <AppText type="defaultSemiBold" style={{ color: view === item ? accentText : ink, fontSize: 14 }}>
                        {item === 'all' ? 'All signals' : 'Following'}
                      </AppText>
                    </Pressable>
                  ))}
                </View>
                {!needsSignIn && feed.items.length > 0 && offline ? (
                  <AppText style={{ color: muted, fontSize: 12 }}>Offline · showing saved signals</AppText>
                ) : null}
                {feed.waitingForSession && session ? (
                  <AppCard>
                    <AppText style={{ color: muted, fontSize: 13 }}>
                      Session offline. Reconnect to load your Following feed.
                    </AppText>
                    <AppButton title="Verify account" variant="secondary" onPress={() => router.push('/sign-in')} />
                  </AppCard>
                ) : null}
                {feed.historyGap ? (
                  <AppCard>
                    <AppText style={{ color: muted, fontSize: 13 }}>
                      Some older events are no longer available. Recent history has been reloaded.
                    </AppText>
                  </AppCard>
                ) : null}
                {!needsSignIn && feed.items.length && (feed.error || feed.followingError) ? (
                  <ConnectionState
                    message={feed.error ?? feed.followingError ?? undefined}
                    retry={() => void feed.refresh()}
                    busy={feed.refreshing}
                  />
                ) : null}
              </View>
            </View>
          }
          ListEmptyComponent={
            <View style={{ paddingHorizontal: 20, gap: 12 }}>
              {needsSignIn ? (
                <AppCard>
                  <AppText type="subtitle">Your wallets. Your feed.</AppText>
                  <AppText style={{ color: muted }}>
                    {status === 'loading'
                      ? 'Restoring your session…'
                      : 'Sign in and follow catalog wallets to see their buys together.'}
                  </AppText>
                  <AppButton
                    title="Sign in with wallet"
                    onPress={() => router.push('/sign-in')}
                    disabled={status === 'loading'}
                  />
                </AppCard>
              ) : feed.status === 'loading' ? (
                <AppCard>
                  <ActivityIndicator color={ink} />
                  <AppText style={{ color: muted, textAlign: 'center' }}>Loading signals…</AppText>
                </AppCard>
              ) : feed.status === 'error' ? (
                <ConnectionState
                  title="Signals are out of reach"
                  message={feed.error ?? undefined}
                  retry={() => void feed.refresh()}
                  busy={feed.refreshing}
                />
              ) : (
                <AppCard>
                  <AppText type="subtitle">
                    {view === 'following' ? 'Build your watchlist' : 'Waiting for the next move'}
                  </AppText>
                  <AppText style={{ color: muted }}>
                    {view === 'following'
                      ? 'Choose wallets from the catalog. Their supported buys will appear here.'
                      : 'The watcher publishes supported wallet buys here with their scores and checks.'}
                  </AppText>
                  <AppButton title="Explore wallets" onPress={() => router.push('/wallets')} />
                  <AppButton
                    title="Refresh signals"
                    variant="secondary"
                    onPress={() => void feed.refresh()}
                    busy={feed.refreshing}
                  />
                </AppCard>
              )}
            </View>
          }
          ListFooterComponent={
            feed.hasMore && !needsSignIn ? (
              <View style={{ paddingHorizontal: 20 }}>
                <AppButton
                  title={offline ? 'Reconnect to load older signals' : 'Load older signals'}
                  busy={feed.loadingMore}
                  disabled={offline}
                  variant="secondary"
                  onPress={() => void feed.loadMore()}
                />
              </View>
            ) : null
          }
        />
      </SafeAreaView>
    </AppView>
  )
}
