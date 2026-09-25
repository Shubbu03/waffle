import type { PublicKey } from '@solana/web3.js'
import { useMutation } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { createTransaction } from './create-transaction'
import { useGetBalanceInvalidate } from './use-get-balance'

export function useTransferSol({ address }: { address: PublicKey }) {
  const { connection, signAndSendTransactions } = useMobileWallet()
  const invalidateBalance = useGetBalanceInvalidate({ address })

  return useMutation({
    mutationKey: ['transfer-sol', { endpoint: connection.rpcEndpoint, address }],
    mutationFn: async (input: { destination: PublicKey; amount: number }) => {
      const { transaction, latestBlockhash, minContextSlot } = await createTransaction({
        address,
        destination: input.destination,
        amount: input.amount,
        connection,
      })

      const signature = await signAndSendTransactions(transaction, minContextSlot)
      const confirmation = await connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed')

      if (confirmation.value.err) {
        throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`)
      }
      return signature
    },
    onSuccess: async () => {
      await invalidateBalance()
    },
  })
}
