import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

/**
 * A trackable whale must be a real on-curve ed25519 wallet (not a PDA or a random
 * base58 string that merely fits the address shape). Free, no RPC call.
 */
export function isOnCurveAddress(address: string): boolean {
  try {
    const bytes = bs58.decode(address);
    if (bytes.length !== 32) return false;
    ed25519.Point.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}
