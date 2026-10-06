import { PublicKey } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { router } from 'expo-router'
import { useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { AccountUiBalance } from '@/components/account/account-ui-balance'
import { AccountUiTokenAccounts } from '@/components/account/account-ui-token-accounts'
import { useGetBalanceInvalidate } from '@/components/account/use-get-balance'
import { useGetTokenAccountsInvalidate } from '@/components/account/use-get-token-accounts'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { WalletUiButtonConnect } from '@/components/solana/wallet-ui-button-connect'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ellipsify } from '@/utils/ellipsify'
import { AccountUiButtons } from './account-ui-buttons'

export function AccountFeature() {
  const { account } = useMobileWallet()
  const { session, serverLinked } = useAuth()
  const muted = useThemeColor({}, 'muted')
  const walletAddress = session?.walletAddress
  return (
    <AppView style={{ flex: 1, gap: 0 }}>
      {walletAddress ? (
        <WalletAccount
          address={new PublicKey(walletAddress)}
          connected={account?.address.toString() === walletAddress}
          serverLinked={serverLinked}
        />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, gap: 20 }}>
          <AppCard>
            <AppText type="title">Your wallet, in one place.</AppText>
            <AppText style={{ color: muted }}>
              Sign in to see your account and keep your follows and paper positions together.
            </AppText>
            <AppButton title="Sign in with wallet" onPress={() => router.push('/sign-in')} />
          </AppCard>
          <AppButton
            title="Explore public signals"
            variant="secondary"
            onPress={() => router.push('/(tabs)/signals')}
          />
        </ScrollView>
      )}
    </AppView>
  )
}
function WalletAccount({
  address,
  connected,
  serverLinked,
}: {
  address: PublicKey
  connected: boolean
  serverLinked: boolean
}) {
  const invalidateBalance = useGetBalanceInvalidate({ address })
  const invalidateTokens = useGetTokenAccountsInvalidate({ address })
  const [refreshing, setRefreshing] = useState(false)
  const muted = useThemeColor({}, 'muted')
  const refresh = async () => {
    setRefreshing(true)
    try {
      await Promise.all([invalidateBalance(), invalidateTokens()])
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 36 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <AppCard>
        <AppText style={{ color: muted, fontSize: 12 }}>SOL BALANCE</AppText>
        <AccountUiBalance address={address} />
        <AppText selectable style={{ color: muted, fontSize: 13 }}>
          {ellipsify(address.toBase58(), 8)}
        </AppText>
        <AppText style={{ color: muted, fontSize: 12 }}>
          {serverLinked ? 'Verified waffle account' : 'Session offline'}
        </AppText>
        {connected ? <AccountUiButtons /> : <WalletUiButtonConnect label="Reconnect wallet" />}
      </AppCard>
      <AppCard>
        <AppText type="subtitle">Practice before you copy.</AppText>
        <AppText style={{ color: muted, fontSize: 14 }}>
          Paper positions use quoted prices and are always marked simulated.
        </AppText>
        <AppButton title="Open paper positions →" onPress={() => router.push('/paper/positions')} />
      </AppCard>
      <View style={{ gap: 12 }}>
        <AccountUiTokenAccounts address={address} />
      </View>
    </ScrollView>
  )
}
