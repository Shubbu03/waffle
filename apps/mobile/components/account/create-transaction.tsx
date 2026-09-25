import {
  type Connection,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

export async function createTransaction({
  address,
  destination,
  amount,
  connection,
}: {
  address: PublicKey
  destination: PublicKey
  amount: number
  connection: Connection
}): Promise<{
  transaction: VersionedTransaction
  latestBlockhash: { blockhash: string; lastValidBlockHeight: number }
  minContextSlot: number
}> {
  const lamports = amount * LAMPORTS_PER_SOL
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error('Enter a valid positive SOL amount.')
  }

  // Get the latest blockhash and slot to use in our transaction
  const {
    context: { slot: minContextSlot },
    value: latestBlockhash,
  } = await connection.getLatestBlockhashAndContext()

  // Create instructions to send, in this case a simple transfer
  const instructions = [
    SystemProgram.transfer({
      fromPubkey: address,
      toPubkey: destination,
      lamports,
    }),
  ]

  // Create a new TransactionMessage with version and compile it to legacy
  const messageLegacy = new TransactionMessage({
    payerKey: address,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToLegacyMessage()

  // Create a new VersionedTransaction which supports legacy and v0
  const transaction = new VersionedTransaction(messageLegacy)

  return {
    transaction,
    latestBlockhash,
    minContextSlot,
  }
}
