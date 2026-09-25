import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MobileWalletProvider } from '@wallet-ui/react-native-web3js'
import type { PropsWithChildren } from 'react'
import { AppTheme } from '@/components/app-theme'
import { AuthProvider } from '@/components/auth/auth-provider'
import { ClusterProvider, useCluster } from '@/components/cluster/cluster-provider'
import { AppConfig } from '@/constants/app-config'

const queryClient = new QueryClient()
export function AppProviders({ children }: PropsWithChildren) {
  return (
    <AppTheme>
      <QueryClientProvider client={queryClient}>
        <ClusterProvider>
          <SolanaProvider>
            <AuthProvider>{children}</AuthProvider>
          </SolanaProvider>
        </ClusterProvider>
      </QueryClientProvider>
    </AppTheme>
  )
}

// We have this SolanaProvider because of the network switching logic.
// If you only connect to a single network, use MobileWalletProvider directly.
function SolanaProvider({ children }: PropsWithChildren) {
  const { selectedCluster } = useCluster()
  return (
    <MobileWalletProvider
      chain={selectedCluster.id}
      endpoint={selectedCluster.endpoint}
      identity={{ name: AppConfig.name, ...(AppConfig.uri ? { uri: AppConfig.uri } : {}) }}
    >
      {children}
    </MobileWalletProvider>
  )
}
