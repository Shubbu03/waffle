import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { Redirect } from 'expo-router'
import { ScrollView } from 'react-native'
import { AccountFeatureReceive } from '@/components/account/account-feature-receive'
import { AppView } from '@/components/app-view'

export default function Receive() {
  const { account } = useMobileWallet()

  if (!account) {
    return <Redirect href="/account" />
  }

  return (
    <AppView style={{ flex: 1 }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <AccountFeatureReceive address={account.address} />
      </ScrollView>
    </AppView>
  )
}
