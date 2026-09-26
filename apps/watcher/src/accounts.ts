import { PublicKey } from "@solana/web3.js";
import { PUMP_SWAP_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, solanaAddressSchema, WRAPPED_SOL_MINT } from "@waffle/shared";
import { z } from "zod";
import { EvidenceUnavailable } from "./evidence-cache.ts";

const accountSchema = z.object({
  owner: solanaAddressSchema,
  executable: z.literal(false),
  data: z.tuple([z.string().max(8192), z.literal("base64")]),
});
const accountsSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative().safe() }),
  value: z.array(accountSchema.nullable()).max(100),
});
export type RpcAccount = z.infer<typeof accountSchema>;
export function parseAccounts(response: unknown, count: number, minSlot: number) {
  const parsed = accountsSchema.safeParse(response);
  if (!parsed.success || parsed.data.value.length !== count || parsed.data.context.slot < minSlot)
    throw new EvidenceUnavailable("invalid-account-response");
  return parsed.data;
}
function bytes(account: RpcAccount | null | undefined, owner: string): Buffer {
  if (!account) throw new EvidenceUnavailable("account-missing");
  if (account.owner !== owner) throw new EvidenceUnavailable("unsupported-account-owner");
  const data = Buffer.from(account.data[0], "base64");
  if (data.toString("base64") !== account.data[0]) throw new EvidenceUnavailable("invalid-account-data");
  return data;
}
function key(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}
function authority(data: Buffer, offset: number): string | null {
  const option = data.readUInt32LE(offset);
  if (option !== 0 && option !== 1) throw new EvidenceUnavailable("invalid-authority-option");
  return option === 0 ? null : key(data, offset + 4);
}
export function decodeMint(account: RpcAccount | null | undefined, address: string) {
  const data = bytes(account, SPL_TOKEN_PROGRAM_ID);
  if (data.length !== 82 || data[45] !== 1) throw new EvidenceUnavailable("invalid-mint");
  return {
    address,
    tokenProgramId: SPL_TOKEN_PROGRAM_ID,
    mintAuthority: authority(data, 0),
    freezeAuthority: authority(data, 46),
    supplyRaw: data.readBigUInt64LE(36).toString(),
    decimals: data.readUInt8(44),
  };
}

/** Stable Pool prefix from PumpSwap's published IDL. Boost/mayhem liquidity needs separate valuation. */
export function decodePool(account: RpcAccount | null | undefined, address: string, mint: string) {
  const data = bytes(account, PUMP_SWAP_PROGRAM_ID);
  if (data.length < 243 || !data.subarray(0, 8).equals(Buffer.from([241, 154, 109, 4, 17, 177, 109, 188])))
    throw new EvidenceUnavailable("invalid-pool");
  if (key(data, 43) !== mint || key(data, 75) !== WRAPPED_SOL_MINT) throw new EvidenceUnavailable("pool-mint-mismatch");
  if (
    (data.length > 243 && data[243] !== 0) ||
    (data.length > 245 && (data.length < 261 || data.subarray(245, 261).some((byte) => byte !== 0)))
  )
    throw new EvidenceUnavailable("unsupported-pool-mode");
  const [expected, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), data.subarray(9, 11), data.subarray(11, 43), data.subarray(43, 75), data.subarray(75, 107)],
    new PublicKey(PUMP_SWAP_PROGRAM_ID),
  );
  if (expected.toBase58() !== address || bump !== data[8]) throw new EvidenceUnavailable("pool-address-mismatch");
  return {
    address,
    baseMint: mint,
    quoteMint: WRAPPED_SOL_MINT,
    baseVault: key(data, 139),
    quoteVault: key(data, 171),
  };
}

export function decodeVault(account: RpcAccount | null | undefined, mint: string, pool: string): bigint {
  const data = bytes(account, SPL_TOKEN_PROGRAM_ID);
  if (data.length !== 165 || data[108] !== 1 || key(data, 0) !== mint || key(data, 32) !== pool)
    throw new EvidenceUnavailable("invalid-pool-vault");
  if (authority(data, 72) !== null || authority(data, 129) !== null)
    throw new EvidenceUnavailable("delegated-pool-vault");
  return data.readBigUInt64LE(64);
}
