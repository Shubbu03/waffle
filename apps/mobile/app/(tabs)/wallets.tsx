import Clipboard from '@react-native-clipboard/clipboard'
import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Switch, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AppPage } from '@/components/app-page'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { useAlertToggle, useFollowWallet, useUnfollowWallet, useWalletRows } from '@/components/wallets/use-wallets'
import { useThemeColor } from '@/hooks/use-theme-color'
import { followLabel, nextAlertsValue, type WalletRow } from '@/lib/wallet-subscription-state'
import { ellipsify } from '@/utils/ellipsify'

function WalletCard({ row }: { row: WalletRow }) {
  const { session } = useAuth()
  const follow = useFollowWallet()
  const unfollow = useUnfollowWallet()
  const alerts = useAlertToggle()
  const buttonBg = useThemeColor({}, 'text')
  const buttonFg = useThemeColor({}, 'background')
  const busy = follow.isPending || unfollow.isPending || alerts.isPending
  const [cardError, setCardError] = useState<string | null>(null)

  const onFollowPress = () => {
    if (!session) {
      console.log('[wallets-screen] follow pressed while signed out -> sign-in')
      router.push('/sign-in')
      return
    }
    if (!session.accessToken) {
      // Wallet-only session: the server cannot attribute this follow yet.
      console.log('[wallets-screen] follow pressed wallet-only — server sign-in required')
      setCardError('Server sign-in needed — reconnect with the API reachable to follow.')
      return
    }
    setCardError(null)
    if (!row.followed) {
      follow.mutate(row.id)
    } else {
      unfollow.mutate(row.id)
    }
  }

  const mutationError =
    follow.error instanceof Error
      ? follow.error.message
      : unfollow.error instanceof Error
        ? unfollow.error.message
        : alerts.error instanceof Error
          ? alerts.error.message
          : null
  const visibleError = cardError ?? mutationError

  const onAlertToggle = () => {
    const next = nextAlertsValue(row)
    if (next === null) return
    alerts.mutate({ walletId: row.id, alertsEnabled: next })
  }

  return (
    <AppView
      style={{
        borderWidth: 2,
        borderRadius: 16,
        padding: 16,
        gap: 8,
        opacity: row.active ? 1 : 0.6,
      }}
    >
      <AppText type="defaultSemiBold">{row.label}</AppText>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          Clipboard.setString(row.address)
          console.log('[wallets-screen] address copied')
        }}
      >
        <AppText style={{ opacity: 0.7 }}>{ellipsify(row.address, 8)} ⧉</AppText>
      </Pressable>
      {!row.active ? (
        <AppText type="defaultSemiBold">Paused — follows and alerts disabled, history kept.</AppText>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          disabled={row.followDisabled || busy}
          style={{
            backgroundColor: buttonBg,
            borderRadius: 12,
            paddingVertical: 10,
            paddingHorizontal: 20,
            opacity: row.followDisabled || busy ? 0.4 : 1,
          }}
          onPress={onFollowPress}
        >
          <AppText type="defaultSemiBold" lightColor={buttonFg} darkColor={buttonFg}>
            {followLabel(row)}
          </AppText>
        </Pressable>
        {row.followed && row.active ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AppText>Alerts</AppText>
            <Switch value={row.alertsEnabled} disabled={busy} onValueChange={onAlertToggle} />
          </View>
        ) : null}
      </View>
      {row.followed && !row.alertsEnabled ? (
        <AppText style={{ opacity: 0.7 }}>Following without alerts. Toggle on to get push alerts.</AppText>
      ) : null}
      {visibleError ? <AppText style={{ color: '#B00020' }}>{visibleError}</AppText> : null}
    </AppView>
  )
}

export default function WalletsScreen() {
  const { session } = useAuth()
  const { rows, catalog, subscriptions } = useWalletRows()

  return (
    <AppPage>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
          <AppText type="title">Wallets</AppText>
          <AppText style={{ opacity: 0.7 }}>Curated whales. Follow what you trust.</AppText>
        </View>
        {catalog.isPending ? (
          <AppView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator />
            <AppText>Loading catalog…</AppText>
          </AppView>
        ) : catalog.isError ? (
          <AppView style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <AppText type="defaultSemiBold">Catalog unavailable.</AppText>
            <AppText style={{ opacity: 0.7 }}>Check your connection and retry.</AppText>
            <Pressable accessibilityRole="button" onPress={() => catalog.refetch()}>
              <AppText type="link">Retry</AppText>
            </Pressable>
          </AppView>
        ) : rows.length === 0 ? (
          <AppView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <AppText type="defaultSemiBold">No wallets tracked yet.</AppText>
          </AppView>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(row) => row.id}
            contentContainerStyle={{ gap: 12, padding: 16 }}
            refreshing={subscriptions.isFetching}
            onRefresh={() => subscriptions.refetch()}
            renderItem={({ item }) => <WalletCard row={item} />}
          />
        )}
        {!session ? (
          <AppView style={{ padding: 16 }}>
            <AppText style={{ opacity: 0.7 }}>Browse freely. Sign in to follow and enable alerts.</AppText>
          </AppView>
        ) : null}
      </SafeAreaView>
    </AppPage>
  )
}
