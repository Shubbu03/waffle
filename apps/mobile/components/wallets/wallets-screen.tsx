import Clipboard from '@react-native-clipboard/clipboard'
import { router, Stack } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Switch, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { ConnectionState } from '@/components/ui/connection-state'
import { TrackWalletButton } from '@/components/wallets/track-wallet-button'
import {
  useAlertToggle,
  useFollowWallet,
  useUnfollowWallet,
  useUntrackWallet,
  useWalletRows,
} from '@/components/wallets/use-wallets'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ageLabel } from '@/lib/signal-state'
import { followLabel, nextAlertsValue, type WalletRow } from '@/lib/wallet-subscription-state'
import { ellipsify } from '@/utils/ellipsify'

function WalletCard({ row }: { row: WalletRow }) {
  const { session, serverLinked } = useAuth()
  const follow = useFollowWallet()
  const unfollow = useUnfollowWallet()
  const untrack = useUntrackWallet()
  const alerts = useAlertToggle()
  const muted = useThemeColor({}, 'muted')
  const danger = useThemeColor({}, 'danger')
  const accent = useThemeColor({}, 'accentSoft')
  const busy = follow.isPending || unfollow.isPending || alerts.isPending || untrack.isPending
  const [copied, setCopied] = useState(false)
  const mutationError = follow.error ?? unfollow.error ?? alerts.error ?? untrack.error
  const onFollow = () => {
    if (!session || !serverLinked) {
      router.push('/sign-in')
      return
    }
    follow.reset()
    unfollow.reset()
    alerts.reset()
    if (row.followed) unfollow.mutate(row.id)
    else follow.mutate(row.id)
  }
  return (
    <AppCard>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View
          style={{
            width: 44,
            height: 44,
            backgroundColor: accent,
            borderRadius: 15,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppText type="defaultSemiBold">{row.label.slice(0, 1)}</AppText>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText type="defaultSemiBold">{row.label}</AppText>
          <AppText style={{ color: muted, fontSize: 12 }}>
            {row.active
              ? `Tracking on ${AppConfig.network === 'mainnet' ? 'Mainnet' : AppConfig.network === 'devnet' ? 'Devnet' : 'Testnet'}`
              : 'Tracking paused'}
            {row.source === 'user' ? ' · Custom' : ''}
          </AppText>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy wallet address"
        onPress={() => {
          Clipboard.setString(row.address)
          setCopied(true)
        }}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <AppText selectable style={{ color: muted, fontSize: 13 }}>
          {ellipsify(row.address, 8)} · {copied ? 'Copied' : 'Copy address'}
        </AppText>
      </Pressable>
      <AppText style={{ color: muted, fontSize: 13, lineHeight: 21 }}>
        {row.inclusionReason || 'Part of the curated wallet catalog.'}
      </AppText>
      <AppText style={{ color: muted, fontSize: 12 }}>
        {row.recentSupportedActivityAt
          ? `Last supported buy ${ageLabel(row.recentSupportedActivityAt, Date.now())}`
          : "Waiting for this wallet's next PumpSwap buy"}
      </AppText>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <AppButton
          title={followLabel(row)}
          variant={row.followed ? 'secondary' : 'primary'}
          disabled={row.followDisabled}
          busy={busy}
          onPress={onFollow}
        />
        {row.followed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AppText style={{ fontSize: 13 }}>Alerts</AppText>
            <Switch
              accessibilityLabel={`Alerts for ${row.label}`}
              value={row.alertsEnabled}
              disabled={busy || !serverLinked || nextAlertsValue(row) === null}
              trackColor={{ true: '#819B46' }}
              onValueChange={() => {
                const next = nextAlertsValue(row)
                if (next !== null) {
                  follow.reset()
                  unfollow.reset()
                  alerts.reset()
                  alerts.mutate({ walletId: row.id, alertsEnabled: next })
                }
              }}
            />
          </View>
        ) : null}
      </View>
      {row.trackedByMe ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stop tracking ${row.label}`}
          disabled={busy}
          onPress={() => {
            if (!session || !serverLinked) {
              router.push('/sign-in')
              return
            }
            untrack.reset()
            untrack.mutate(row.id)
          }}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <AppText style={{ color: danger, fontSize: 13 }}>
            {untrack.isPending ? 'Untracking…' : 'Untrack this wallet'}
          </AppText>
        </Pressable>
      ) : null}
      {!row.active ? (
        <AppText style={{ color: muted, fontSize: 12 }}>
          New follows and alerts are paused. Existing follows can be removed.
        </AppText>
      ) : row.followed && !row.alertsEnabled ? (
        <AppText style={{ color: muted, fontSize: 12 }}>
          Following quietly. Turn alerts on when you want notifications.
        </AppText>
      ) : null}
      {mutationError ? (
        <AppText selectable accessibilityLiveRegion="polite" style={{ color: danger, fontSize: 13 }}>
          {mutationError.message}
        </AppText>
      ) : null}
    </AppCard>
  )
}

export function WalletsScreen() {
  const { session, serverLinked } = useAuth()
  const { rows, catalog, subscriptions, mine } = useWalletRows()
  const muted = useThemeColor({}, 'muted')
  const refresh = () => {
    void catalog.refetch()
    if (serverLinked) {
      void subscriptions.refetch()
      void mine.refetch()
    }
  }
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      <Stack.Screen
        options={{ headerShown: true, title: 'Wallets', headerBackTitle: 'Back', headerShadowVisible: false }}
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 36, gap: 14 }}
        refreshing={catalog.isRefetching || subscriptions.isRefetching}
        onRefresh={refresh}
        renderItem={({ item }) => <WalletCard row={item} />}
        ListHeaderComponent={
          <View style={{ gap: 14, paddingBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <AppText type="subtitle" style={{ flex: 1, fontSize: 18 }}>
                Discover wallets
              </AppText>
              <TrackWalletButton />
            </View>
            {!session ? (
              <AppCard>
                <AppText style={{ color: muted, fontSize: 13 }}>
                  Browse freely. Sign in to save follows and choose alerts.
                </AppText>
                <AppButton title="Sign in with wallet" onPress={() => router.push('/sign-in')} />
              </AppCard>
            ) : !serverLinked ? (
              <AppCard>
                <AppText style={{ color: muted }}>Your account is offline. Reconnect before changing follows.</AppText>
                <AppButton title="Verify account" variant="secondary" onPress={() => router.push('/sign-in')} />
              </AppCard>
            ) : null}
            {subscriptions.isError ? (
              <ConnectionState
                title="Follows could not be loaded"
                message={subscriptions.error.message}
                retry={refresh}
              />
            ) : null}
            {catalog.isError && rows.length ? (
              <ConnectionState title="Showing saved catalog" message={catalog.error.message} retry={refresh} />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          catalog.isPending ? (
            <AppCard>
              <ActivityIndicator />
              <AppText style={{ color: muted }}>Loading wallets…</AppText>
            </AppCard>
          ) : catalog.isError ? (
            <ConnectionState
              title="Catalog is out of reach"
              message={catalog.error.message}
              retry={refresh}
              busy={catalog.isFetching}
            />
          ) : (
            <AppCard>
              <AppText type="subtitle">No catalog wallets yet</AppText>
              <AppText style={{ color: muted }}>
                The catalog will appear once reviewed wallets have been added to waffle.
              </AppText>
              <AppButton title="Refresh catalog" variant="secondary" onPress={refresh} />
            </AppCard>
          )
        }
      />
    </AppView>
  )
}
