import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { SignalWalletCard } from '@/components/signals/signal-wallet-card'
import { useSignalClock, useSignalFeed } from '@/components/signals/use-signals'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { ConnectionState } from '@/components/ui/connection-state'
import { ScreenHeading } from '@/components/ui/screen-heading'
import { useThemeColor } from '@/hooks/use-theme-color'
import type { SignalView } from '@/lib/signal-state'
import { signalWallets } from '@/lib/signal-wallets'

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
  const wallets = signalWallets(feed.catalog, feed.items, view, feed.subscribedWalletIds)
  const needsSignIn = view === 'following' && !session
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <FlatList
          data={needsSignIn ? [] : wallets}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 28, gap: 12, flexGrow: 1 }}
          refreshing={feed.refreshing}
          onRefresh={() => void feed.refresh()}
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: 20 }}>
              <SignalWalletCard wallet={item} view={view} now={now} />
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
                  <AppText style={{ color: muted, fontSize: 12 }}>Offline · activity may be out of date</AppText>
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
                {!needsSignIn && wallets.length > 0 && (feed.error || feed.followingError || feed.catalogError) ? (
                  <ConnectionState
                    message={feed.followingError ?? feed.error ?? 'Unable to refresh wallets.'}
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
                  <AppText type="subtitle">Followed wallets</AppText>
                  <AppText style={{ color: muted }}>
                    {status === 'loading' ? 'Restoring your session…' : 'Sign in to see the wallets you follow.'}
                  </AppText>
                  <AppButton
                    title="Sign in with wallet"
                    onPress={() => router.push('/sign-in')}
                    disabled={status === 'loading'}
                  />
                </AppCard>
              ) : feed.catalogLoading ||
                feed.status === 'loading' ||
                (view === 'following' && feed.subscriptionsLoading) ? (
                <AppCard>
                  <ActivityIndicator color={ink} />
                  <AppText style={{ color: muted, textAlign: 'center' }}>Loading wallets…</AppText>
                </AppCard>
              ) : feed.catalogError || feed.status === 'error' || feed.followingError ? (
                <ConnectionState
                  title="Unable to load wallets"
                  message={feed.followingError ?? feed.error ?? 'Unable to load wallets.'}
                  retry={() => void feed.refresh()}
                  busy={feed.refreshing}
                />
              ) : (
                <AppCard>
                  <AppText type="subtitle">
                    {view === 'following' ? 'No followed wallets' : 'No tracked wallets yet'}
                  </AppText>
                  <AppText style={{ color: muted }}>
                    {view === 'following'
                      ? 'Follow a wallet to see its signals here.'
                      : 'Tracked wallets will appear here when added to the catalog.'}
                  </AppText>
                  <AppButton title="Explore wallets" onPress={() => router.push('/wallets')} />
                  <AppButton
                    title="Refresh"
                    variant="secondary"
                    onPress={() => void feed.refresh()}
                    busy={feed.refreshing}
                  />
                </AppCard>
              )}
            </View>
          }
        />
      </SafeAreaView>
    </AppView>
  )
}
