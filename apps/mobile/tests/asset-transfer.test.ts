import { expect, test } from 'bun:test'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { type Connection, Keypair, PublicKey, TransactionMessage } from '@solana/web3.js'
import { USDC_MINT } from '@waffle/shared'
import { createTransaction } from '../components/account/create-transaction'

const owner = Keypair.generate().publicKey
const recipient = Keypair.generate().publicKey
function rpc(accounts: Array<{ owner?: string; mint?: string; amount: string }> = [], simulationError: unknown = null) {
  let simulated = 0
  return {
    connection: {
      async getParsedTokenAccountsByOwner() {
        return {
          value: accounts.map((entry) => ({
            pubkey: Keypair.generate().publicKey,
            account: {
              owner: TOKEN_PROGRAM_ID,
              data: {
                parsed: {
                  info: {
                    mint: entry.mint ?? USDC_MINT,
                    owner: entry.owner ?? owner.toBase58(),
                    tokenAmount: { amount: entry.amount, decimals: 6 },
                  },
                },
              },
            },
          })),
        }
      },
      async getLatestBlockhashAndContext() {
        return { context: { slot: 1 }, value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1000 } }
      },
      async simulateTransaction() {
        simulated++
        return { value: { err: simulationError } }
      },
    } as unknown as Connection,
    simulated: () => simulated,
  }
}

test('USDC send uses checked transfers with exact six-decimal amounts and the connected fee payer', async () => {
  const fake = rpc([{ amount: '1000000' }, { amount: '1' }])
  const { transaction } = await createTransaction({
    address: owner,
    destination: recipient,
    amount: '1.000001',
    asset: 'USDC',
    network: 'mainnet',
    connection: fake.connection,
  })
  const message = TransactionMessage.decompile(transaction.message)
  expect(message.payerKey.equals(owner)).toBe(true)
  const transfers = message.instructions.filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID))
  expect(transfers.map((ix) => ix.data.readBigUInt64LE(1))).toEqual([1000000n, 1n])
  expect(
    transfers.every((ix) => ix.data[0] === 12 && ix.data[9] === 6 && ix.keys[1].pubkey.toBase58() === USDC_MINT),
  ).toBe(true)
  expect(fake.simulated()).toBe(1)
})

test('foreign token accounts, unsupported networks and excessive precision cannot authorize USDC sends', async () => {
  const fake = rpc([{ owner: recipient.toBase58(), amount: '9999999' }])
  const input = {
    address: owner,
    destination: recipient,
    amount: '1',
    asset: 'USDC' as const,
    connection: fake.connection,
  }
  await expect(createTransaction(input)).rejects.toThrow('Not enough USDC')
  await expect(createTransaction({ ...input, network: 'testnet' })).rejects.toThrow('unavailable')
  await expect(createTransaction({ ...input, amount: '1.0000001' })).rejects.toThrow('valid positive USDC')
  expect(fake.simulated()).toBe(0)
})

test('simulation failure prevents obtaining a transfer for wallet approval', async () => {
  const fake = rpc([], { InstructionError: [0, 'InsufficientFunds'] })
  await expect(
    createTransaction({
      address: owner,
      destination: recipient,
      amount: '0.000000001',
      asset: 'SOL',
      connection: fake.connection,
    }),
  ).rejects.toThrow('simulation failed')
})
