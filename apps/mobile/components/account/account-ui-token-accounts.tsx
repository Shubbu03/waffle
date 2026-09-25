import type { PublicKey } from '@solana/web3.js'
import { ActivityIndicator, View } from 'react-native'
import { AccountUiTokenBalance } from '@/components/account/account-ui-token-balance'
import { useGetTokenAccounts } from '@/components/account/use-get-token-accounts'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { ellipsify } from '@/utils/ellipsify'

export function AccountUiTokenAccounts({ address }: { address: PublicKey }) {
  const query = useGetTokenAccounts({ address })
  const items = query.data ?? []

  return (
    <>
      <AppText type="subtitle" style={{ marginBottom: 8 }}>
        Token Accounts
      </AppText>
      {query.isLoading && <ActivityIndicator animating={true} />}
      {query.isError && (
        <AppText style={{ padding: 8, backgroundColor: 'red' }}>Error: {query.error?.message.toString()}</AppText>
      )}
      {query.isSuccess && (
        <View style={{ padding: 0 }}>
          <AppView style={{ flexDirection: 'row', paddingHorizontal: 8, width: '100%' }}>
            <AppText style={{ flex: 1, fontWeight: 'bold' }}>Public Key</AppText>
            <AppText style={{ flex: 1, fontWeight: 'bold' }}>Mint</AppText>
            <AppText style={{ flex: 1, fontWeight: 'bold', textAlign: 'right' }}>Balance</AppText>
          </AppView>
          {query.data.length === 0 && (
            <View style={{ marginTop: 12 }}>
              <AppText>No token accounts found.</AppText>
            </View>
          )}

          {items.map((item) => (
            <AppView
              key={item.pubkey.toString()}
              style={{
                flexDirection: 'row',
                padding: 8,
                borderBottomWidth: 1,
                borderBottomColor: '#ddd',
              }}
            >
              <AppText style={{ flex: 1 }}>{ellipsify(item.pubkey.toString())}</AppText>
              <AppText style={{ flex: 1 }}>{ellipsify(item.account.data.parsed.info.mint)}</AppText>
              <View style={{ flex: 1, alignItems: 'flex-end' }}>
                <AccountUiTokenBalance address={item.pubkey} />
              </View>
            </AppView>
          ))}
        </View>
      )}
    </>
  )
}
