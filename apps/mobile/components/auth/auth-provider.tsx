import { useMutation } from '@tanstack/react-query'
import { type SignInOutput, useMobileWallet } from '@wallet-ui/react-native-web3js'
import { createContext, type PropsWithChildren, use, useMemo } from 'react'
import { AppConfig } from '@/constants/app-config'

export interface AuthState {
  isAuthenticated: boolean
  signIn: () => Promise<SignInOutput>
  signOut: () => Promise<void>
}

const Context = createContext<AuthState>({} as AuthState)

export function useAuth() {
  const value = use(Context)
  if (!value) {
    throw new Error('useAuth must be wrapped in a <AuthProvider />')
  }

  return value
}

function useSignInMutation() {
  const { signIn } = useMobileWallet()

  return useMutation({
    mutationFn: async () => {
      if (!AppConfig.uri) {
        throw new Error('Set EXPO_PUBLIC_WAFFLE_APP_URI to your public HTTPS app URL before signing in.')
      }
      return await signIn({
        uri: AppConfig.uri,
      })
    },
  })
}

export function AuthProvider({ children }: PropsWithChildren) {
  const { accounts, disconnect } = useMobileWallet()
  const signInMutation = useSignInMutation()

  const value: AuthState = useMemo(
    () => ({
      signIn: async () => await signInMutation.mutateAsync(),
      signOut: async () => await disconnect(),
      isAuthenticated: (accounts?.length ?? 0) > 0,
      isLoading: signInMutation.isPending,
    }),
    [accounts, disconnect, signInMutation],
  )

  return <Context value={value}>{children}</Context>
}
