import type { PublicKey } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { DemoFeatureSignMessage } from './demo-feature-sign-message'

export function DemoFeature() {
  const { account } = useMobileWallet()
  return (
    <AppView>
      <AppText type="subtitle">Demo page</AppText>
      <AppText>Start building your features here.</AppText>
      <DemoFeatureSignMessage address={account?.address as PublicKey} />
    </AppView>
  )
}
