import { z } from "zod";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Validates decoded byte length, not only the length of the base58 text. */
export function isBase58Bytes(value: string, expectedBytes: number): boolean {
  if (value.length === 0 || value.length > 88) return false;

  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }

  let nonzeroBytes = 0;
  while (decoded > 0n) {
    decoded >>= 8n;
    nonzeroBytes += 1;
  }

  const leadingZeroBytes = value.match(/^1*/)?.[0].length ?? 0;
  return leadingZeroBytes + nonzeroBytes === expectedBytes;
}

export const solanaAddressSchema = z
  .string()
  .refine((value) => isBase58Bytes(value, 32), "Expected a 32-byte base58 Solana address");

export const transactionSignatureSchema = z
  .string()
  .refine((value) => isBase58Bytes(value, 64), "Expected a 64-byte base58 transaction signature");

export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime({ offset: true });
export const slotSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const U64_MAX = 18_446_744_073_709_551_615n;
const unsignedDecimal = /^(0|[1-9]\d*)$/;
export function parseRawAmount(value: string): bigint | null {
  return value.length <= 20 && unsignedDecimal.test(value) ? BigInt(value) : null;
}
export const rawAmountSchema = z
  .string()
  .max(20)
  .refine((value) => {
    const amount = parseRawAmount(value);
    return amount !== null && amount <= U64_MAX;
  }, "Expected a decimal unsigned 64-bit amount");
export const positiveRawAmountSchema = rawAmountSchema.refine((value) => value !== "0", "Amount must be positive");

const INT64_MAX = 9_223_372_036_854_775_807n;
/** Decimal Postgres bigint event ID. Never serialize this cursor as a JS number. */
export const eventCursorSchema = z
  .string()
  .max(19)
  .refine((value) => {
    const cursor = parseRawAmount(value);
    return cursor !== null && cursor > 0n && cursor <= INT64_MAX;
  }, "Cursor exceeds signed 64-bit range");

export type SolanaAddress = z.infer<typeof solanaAddressSchema>;
export type EventCursor = z.infer<typeof eventCursorSchema>;
