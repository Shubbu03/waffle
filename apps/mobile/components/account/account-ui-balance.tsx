import type { PublicKey } from '@solana/web3.js'
import { ActivityIndicator, View } from 'react-native'
import { useGetBalance } from '@/components/account/use-get-balance'
import { AppText } from '@/components/app-text'
import { AppButton } from '@/components/ui/app-button'
import { useThemeColor } from '@/hooks/use-theme-color'
import { lamportsToSol } from '@/utils/lamports-to-sol'

export function AccountUiBalance({ address }: { address: PublicKey }) {
  const query = useGetBalance({ address })
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ gap: 8 }}>
      {query.data !== undefined ? (
        <AppText selectable type="title" style={{ fontSize: 36, lineHeight: 46, fontVariant: ['tabular-nums'] }}>
          {lamportsToSol(query.data)} SOL
        </AppText>
      ) : query.isPending ? (
        <ActivityIndicator />
      ) : (
        <AppText type="subtitle">Balance unavailable</AppText>
      )}
      {query.isError ? (
        <>
          <AppText style={{ color: muted, fontSize: 13 }}>
            {query.data !== undefined
              ? 'Last loaded balance · refresh failed.'
              : 'The Solana network could not return your balance.'}
          </AppText>
          <AppButton
            title="Refresh balance"
            variant="secondary"
            onPress={() => void query.refetch()}
            busy={query.isFetching}
          />
        </>
      ) : null}
    </View>
  )
}
