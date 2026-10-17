import type { PublicKey } from '@solana/web3.js'
import { useMutation } from '@tanstack/react-query'
import type { PaymentAsset } from '@waffle/shared'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { useRef } from 'react'
import { AppConfig } from '@/constants/app-config'
import { createTransaction } from './create-transaction'
import { useGetBalanceInvalidate } from './use-get-balance'
import { useGetTokenAccountsInvalidate } from './use-get-token-accounts'

export function useTransferAsset({ address }: { address: PublicKey }) {
  const { connection, account, signAndSendTransactions } = useMobileWallet()
  const current = useRef(account?.address.toString())
  current.current = account?.address.toString()
  const invalidateTokens = useGetTokenAccountsInvalidate({ address })
  const invalidateBalance = useGetBalanceInvalidate({ address })

  return useMutation({
    mutationKey: ['transfer-asset', { endpoint: connection.rpcEndpoint, address }],
    retry: false,
    mutationFn: async (input: {
      destination: PublicKey
      amount: string
      asset: PaymentAsset
      onSubmitted: (signature: string) => void
    }) => {
      const network = AppConfig.network
      if (current.current !== address.toBase58()) throw new Error('Reconnect the sending wallet.')
      const { transaction, latestBlockhash, minContextSlot } = await createTransaction({
        address,
        destination: input.destination,
        amount: input.amount,
        asset: input.asset,
        network,
        connection,
      })

      if (current.current !== address.toBase58() || AppConfig.network !== network)
        throw new Error('Wallet or network changed. Review the transfer again.')
      const signature = await signAndSendTransactions(transaction, minContextSlot)
      input.onSubmitted(signature)
      const confirmation = await connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed')

      if (confirmation.value.err) {
        throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`)
      }
      return signature
    },
    onSuccess: async () => {
      await Promise.all([invalidateBalance(), invalidateTokens()])
    },
  })
}
