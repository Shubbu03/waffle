import type { PublicKey } from '@solana/web3.js'
import { formatAssetAmount, usdcMintForNetwork } from '@waffle/shared'
import { AppText } from '@/components/app-text'
import { useCluster } from '@/components/cluster/cluster-provider'
import { AppConfig } from '@/constants/app-config'
import { useGetTokenAccounts } from './use-get-token-accounts'

export function AccountUsdcBalance({ address }: { address: PublicKey }) {
  useCluster()
  const query = useGetTokenAccounts({ address })
  const mint = usdcMintForNetwork(AppConfig.network)
  if (!mint) return null
  const balances = query.data?.filter((item) => item.account.data.parsed.info.mint === mint)
  const raw = balances?.reduce((sum, item) => sum + BigInt(item.account.data.parsed.info.tokenAmount.amount), 0n)
  return (
    <AppText selectable type="subtitle">
      {query.isError
        ? 'USDC balance unavailable'
        : raw === undefined
          ? 'Loading USDC…'
          : `${formatAssetAmount(raw.toString(), 6)} USDC${AppConfig.network === 'devnet' ? ' · test tokens' : ''}`}
    </AppText>
  )
}
