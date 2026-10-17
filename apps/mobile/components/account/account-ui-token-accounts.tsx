import type { PublicKey } from '@solana/web3.js'
import { usdcMintForNetwork } from '@waffle/shared'
import { ActivityIndicator, View } from 'react-native'
import { useGetTokenAccounts } from '@/components/account/use-get-token-accounts'
import { AppText } from '@/components/app-text'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ellipsify } from '@/utils/ellipsify'

export function AccountUiTokenAccounts({ address }: { address: PublicKey }) {
  useCluster()
  const usdcMint = usdcMintForNetwork(AppConfig.network)
  const query = useGetTokenAccounts({ address })
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ gap: 12 }}>
      <AppText type="subtitle">Token holdings</AppText>
      {query.isPending ? <ActivityIndicator /> : null}
      {query.isError ? (
        <AppCard>
          <AppText style={{ color: muted }}>Token holdings could not be refreshed.</AppText>
          <AppButton
            title="Try again"
            variant="secondary"
            onPress={() => void query.refetch()}
            busy={query.isFetching}
          />
        </AppCard>
      ) : null}
      {query.isSuccess && !query.data.length ? (
        <AppCard>
          <AppText style={{ color: muted, fontSize: 14 }}>No token accounts on this network yet.</AppText>
        </AppCard>
      ) : null}
      {(query.data ?? []).map((item) => (
        <AppCard key={item.pubkey.toBase58()} style={{ padding: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
                {item.account.data.parsed.info.mint === usdcMint ? 'USDC' : 'Token'}
              </AppText>
              <AppText selectable style={{ color: muted, fontSize: 12 }}>
                {ellipsify(item.account.data.parsed.info.mint, 6)}
              </AppText>
            </View>
            <AppText selectable style={{ fontVariant: ['tabular-nums'], flexShrink: 1 }}>
              {item.account.data.parsed.info.tokenAmount.uiAmountString}
            </AppText>
          </View>
        </AppCard>
      ))}
    </View>
  )
}
