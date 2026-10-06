import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { Redirect } from 'expo-router'
import { ScrollView } from 'react-native'
import { AccountFeatureSend } from '@/components/account/account-feature-send'
import { AppView } from '@/components/app-view'

export default function Send() {
  const { account } = useMobileWallet()

  if (!account) {
    return <Redirect href="/account" />
  }

  return (
    <AppView style={{ flex: 1 }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      >
        <AccountFeatureSend address={account.address} />
      </ScrollView>
    </AppView>
  )
}
