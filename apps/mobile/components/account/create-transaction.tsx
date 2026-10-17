import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { type Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { type PaymentAsset, parseAssetAmount, usdcMintForNetwork } from '@waffle/shared'

export async function createTransaction({
  address,
  destination,
  amount,
  connection,
  asset = 'SOL',
  network = 'mainnet',
}: {
  address: PublicKey
  destination: PublicKey
  amount: string
  connection: Connection
  asset?: PaymentAsset
  network?: string
}) {
  const raw = parseAssetAmount(amount, asset === 'SOL' ? 9 : 6)
  if (!raw) throw new Error(`Enter a valid positive ${asset} amount.`)
  const instructions = []
  if (asset === 'SOL') {
    instructions.push(SystemProgram.transfer({ fromPubkey: address, toPubkey: destination, lamports: BigInt(raw) }))
  } else {
    const configuredMint = usdcMintForNetwork(network)
    if (!configuredMint) throw new Error('USDC transfers are unavailable on this network.')
    const mint = new PublicKey(configuredMint)
    const destinationAccount = getAssociatedTokenAddressSync(mint, destination)
    const accounts = await connection.getParsedTokenAccountsByOwner(address, { mint }, 'confirmed')
    let remaining = BigInt(raw)
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(address, destinationAccount, destination, mint))
    for (const account of accounts.value) {
      const info = account.account.data.parsed.info
      if (
        !account.account.owner.equals(TOKEN_PROGRAM_ID) ||
        info.mint !== configuredMint ||
        info.owner !== address.toBase58() ||
        info.tokenAmount.decimals !== 6
      )
        continue
      const available = BigInt(info.tokenAmount.amount)
      const take = available < remaining ? available : remaining
      if (take > 0n)
        instructions.push(createTransferCheckedInstruction(account.pubkey, mint, destinationAccount, address, take, 6))
      remaining -= take
      if (remaining === 0n) break
    }
    if (remaining > 0n) throw new Error('Not enough USDC for this transfer.')
    if (instructions.length > 8)
      throw new Error('USDC is spread over too many token accounts. Consolidate it in your wallet first.')
  }
  const {
    context: { slot: minContextSlot },
    value: latestBlockhash,
  } = await connection.getLatestBlockhashAndContext('confirmed')
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: address,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message(),
  )
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, commitment: 'confirmed' })
  if (simulation.value.err)
    throw new Error('Transfer simulation failed. Check your asset balance and SOL for fees and account rent.')
  return { transaction, latestBlockhash, minContextSlot }
}
