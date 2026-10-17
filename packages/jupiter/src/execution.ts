import {
  type JupiterExecutionResult,
  type RealOrder,
  transactionSignatureSchema,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import { z } from "zod";

export type ExecutionRpc = {
  call(
    method: "getSignatureStatuses" | "getTransaction" | "getBlockHeight" | "simulateTransaction",
    params: unknown[],
  ): Promise<unknown>;
};

const tokenBalance = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int().min(0).max(255) }),
});
const transactionSchema = z.object({
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({
      accountKeys: z.array(z.union([z.string(), z.object({ pubkey: z.string(), signer: z.boolean() })])),
    }),
  }),
  meta: z.object({
    err: z.unknown(),
    fee: z.number().int().nonnegative(),
    preBalances: z.array(z.number().int().nonnegative()),
    postBalances: z.array(z.number().int().nonnegative()),
    preTokenBalances: z.array(tokenBalance),
    postTokenBalances: z.array(tokenBalance),
  }),
});
const statusSchema = z.object({
  value: z.array(z.object({ err: z.unknown(), confirmationStatus: z.string().nullable() }).nullable()),
});

/** Reads only. A timeout, missing RPC response or missing receipt never triggers another broadcast. */
export async function reconcileExecution(
  rpc: ExecutionRpc,
  signature: string,
  requestId: string,
  taker: string,
  mint: string,
  order?: RealOrder,
): Promise<JupiterExecutionResult | null> {
  transactionSignatureSchema.parse(signature);
  const statuses = () => rpc.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const status = statusSchema.parse(await statuses()).value[0];
  if (status && status.err !== null) return { status: "failed", requestId, code: -1, signature };
  if (status?.confirmationStatus !== "confirmed" && status?.confirmationStatus !== "finalized") {
    if (!status && order) {
      const height = z
        .number()
        .int()
        .nonnegative()
        .safe()
        .parse(await rpc.call("getBlockHeight", [{ commitment: "finalized" }]));
      if (BigInt(height) > BigInt(order.lastValidBlockHeight) && !statusSchema.parse(await statuses()).value[0])
        return { status: "expired", requestId, code: -9999, signature };
    }
    return null;
  }
  const raw = await rpc.call("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (raw === null) return null;
  const tx = transactionSchema.parse(raw);
  const payer = tx.transaction.message.accountKeys[0];
  if ((typeof payer === "string" ? payer : payer?.pubkey) !== taker || tx.transaction.signatures[0] !== signature)
    throw new Error("Transaction identity mismatch");
  if (tx.meta.err !== null) return { status: "failed", requestId, code: -1, signature };
  const sum = (balances: z.infer<typeof tokenBalance>[], asset: string) =>
    balances
      .filter((b) => b.owner === taker && b.mint === asset)
      .reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n);
  const output = sum(tx.meta.postTokenBalances, mint) - sum(tx.meta.preTokenBalances, mint);
  const decimals = tx.meta.postTokenBalances.find((b) => b.owner === taker && b.mint === mint)?.uiTokenAmount.decimals;
  if (output <= 0n || decimals === undefined || (order && output < BigInt(order.minOutputAmountRaw)))
    throw new Error("Transaction output mismatch");
  // Native SOL debit also includes account rent. Preserve the approved swap input separately from network fees.
  const input =
    order?.inputMint === WRAPPED_SOL_MINT
      ? BigInt(order.inputAmountRaw)
      : order
        ? sum(tx.meta.preTokenBalances, order.inputMint) - sum(tx.meta.postTokenBalances, order.inputMint)
        : 0n;
  if (!order || input <= 0n || input > BigInt(order.inputAmountRaw)) throw new Error("Transaction input mismatch");
  const walletDebit = BigInt(tx.meta.preBalances[0] ?? 0) - BigInt(tx.meta.postBalances[0] ?? 0);
  if (order.inputMint === WRAPPED_SOL_MINT && walletDebit < input + BigInt(tx.meta.fee))
    throw new Error("Transaction debit mismatch");
  return {
    status: "confirmed",
    code: 0,
    requestId,
    signature,
    totalInputAmountRaw: input.toString(),
    inputAmountResultRaw: input.toString(),
    totalOutputAmountRaw: output.toString(),
    outputAmountResultRaw: output.toString(),
    feeLamports: String(tx.meta.fee),
    outputDecimals: decimals,
  };
}
