import { idSchema } from '@waffle/shared'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { ActivityIndicator, FlatList, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { SignalCard } from '@/components/signals/signal-card'
import { useSignalClock, useSignalFeed } from '@/components/signals/use-signals'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { ConnectionState } from '@/components/ui/connection-state'
import { useThemeColor } from '@/hooks/use-theme-color'
import type { SignalView } from '@/lib/signal-state'
import { ellipsify } from '@/utils/ellipsify'

export function WalletSignalScreen() {
  const params = useLocalSearchParams<{ walletId: string; view?: string }>()
  const parsed = idSchema.safeParse(params.walletId)
  if (!parsed.success)
    return (
      <AppView style={{ flex: 1, padding: 20 }}>
        <Stack.Screen options={{ headerShown: true, title: 'Wallet signals' }} />
        <AppText>Invalid wallet.</AppText>
      </AppView>
    )
  return <WalletHistory walletId={parsed.data} view={params.view === 'following' ? 'following' : 'all'} />
}

function WalletHistory({ walletId, view }: { walletId: string; view: SignalView }) {
  const { session } = useAuth()
  const feed = useSignalFeed(view, walletId)
  const now = useSignalClock()
  const ink = useThemeColor({}, 'text')
  const muted = useThemeColor({}, 'muted')
  const wallet = feed.catalog.find((item) => item.id === walletId)
  const address = wallet?.address ?? feed.items[0]?.walletAddress
  const needsSignIn = view === 'following' && !session
  const offline = feed.status === 'cached' || !feed.fetchedAt || now - feed.fetchedAt > 45_000
  const error = feed.followingError ?? feed.error
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Wallet signals', headerTintColor: ink }} />
      <FlatList
        data={needsSignIn ? [] : feed.items}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 36, gap: 12, flexGrow: 1 }}
        refreshing={feed.refreshing}
        onRefresh={() => void feed.refresh()}
        renderItem={({ item }) => <SignalCard signal={item} offline={offline} now={now} showWallet={false} />}
        ListHeaderComponent={
          <View style={{ gap: 16, paddingBottom: 8 }}>
            <AppCard>
              <AppText type="subtitle">{wallet?.label || (address ? ellipsify(address, 6) : 'Tracked wallet')}</AppText>
              {address ? (
                <AppText selectable style={{ color: muted, fontSize: 13 }}>
                  {address}
                </AppText>
              ) : null}
              {wallet?.active === false ? (
                <AppText style={{ color: muted, fontSize: 12 }}>Tracking paused</AppText>
              ) : null}
            </AppCard>
            <AppText type="defaultSemiBold">Signals</AppText>
            {feed.items.length > 0 && offline ? (
              <AppText style={{ color: muted, fontSize: 12 }}>Offline · showing saved signals</AppText>
            ) : null}
            {feed.historyGap ? (
              <AppText style={{ color: muted, fontSize: 12 }}>
                Older events have expired. Recent history has been reloaded.
              </AppText>
            ) : null}
            {feed.waitingForSession && session ? (
              <AppCard>
                <AppText style={{ color: muted }}>Reconnect to load followed wallet signals.</AppText>
                <AppButton title="Verify account" variant="secondary" onPress={() => router.push('/sign-in')} />
              </AppCard>
            ) : null}
            {feed.items.length > 0 && error ? (
              <ConnectionState message={error} retry={() => void feed.refresh()} busy={feed.refreshing} />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          needsSignIn ? (
            <AppCard>
              <AppText>Sign in to view followed wallet signals.</AppText>
              <AppButton title="Sign in with wallet" onPress={() => router.push('/sign-in')} />
            </AppCard>
          ) : feed.status === 'loading' || (view === 'following' && feed.subscriptionsLoading) ? (
            <View style={{ alignItems: 'center', padding: 32, gap: 12 }}>
              <ActivityIndicator color={ink} />
              <AppText style={{ color: muted }}>Loading signals…</AppText>
            </View>
          ) : error ? (
            <ConnectionState
              title="Unable to load signals"
              message={error}
              retry={() => void feed.refresh()}
              busy={feed.refreshing}
            />
          ) : (
            <AppCard>
              <AppText type="subtitle">No signals yet</AppText>
              <AppText style={{ color: muted }}>
                {view === 'following' && feed.subscribedWalletIds && !feed.subscribedWalletIds.includes(walletId)
                  ? 'This wallet is no longer in your watchlist.'
                  : 'Supported buys from this wallet will appear here.'}
              </AppText>
            </AppCard>
          )
        }
        ListFooterComponent={
          feed.hasMore && !needsSignIn ? (
            <AppButton
              title="Load older signals"
              variant="secondary"
              busy={feed.loadingMore}
              disabled={offline}
              onPress={() => void feed.loadMore()}
            />
          ) : null
        }
      />
    </AppView>
  )
}
