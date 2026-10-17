import { z } from "zod";
import { WRAPPED_SOL_MINT } from "./program-ids.ts";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const paymentMintSchema = z.enum([WRAPPED_SOL_MINT, USDC_MINT]);
export type PaymentMint = z.infer<typeof paymentMintSchema>;
export type PaymentAsset = "SOL" | "USDC";

export const paymentAssets = {
  SOL: { symbol: "SOL", mint: WRAPPED_SOL_MINT, decimals: 9, realMax: 50_000_000n, paperMax: 100_000_000n },
  USDC: { symbol: "USDC", mint: USDC_MINT, decimals: 6, realMax: 5_000_000n, paperMax: 10_000_000n },
} as const;

export function paymentAsset(mint: string) {
  if (mint === WRAPPED_SOL_MINT) return paymentAssets.SOL;
  if (mint === USDC_MINT || mint === DEVNET_USDC_MINT) return paymentAssets.USDC;
  throw new Error("Unsupported payment asset");
}

export function paymentSizeAllowed(mint: string, raw: string, mode: "paper" | "real") {
  if (!paymentMintSchema.safeParse(mint).success || !/^[1-9]\d{0,19}$/.test(raw)) return false;
  return BigInt(raw) <= paymentAsset(mint)[mode === "real" ? "realMax" : "paperMax"];
}

export function parseAssetAmount(text: string, decimals: number): string | null {
  if (text.length > 30 || !new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${decimals}})?$`).test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
  return raw > 0n && raw <= 18_446_744_073_709_551_615n ? raw.toString() : null;
}

export function formatAssetAmount(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${value < 0n ? "-" : ""}${decimals ? digits.slice(0, -decimals) : digits}${fraction ? `.${fraction}` : ""}`;
}

export function formatPayment(raw: string, mint: string) {
  const asset = paymentAsset(mint);
  return `${formatAssetAmount(raw, asset.decimals)} ${asset.symbol}`;
}

/** Manual execution policy is separate from immutable historical scoring. */
export const realTradePolicy = {
  quoteMs: 45_000,
  maxSlippageBps: 500,
  maxPriceImpactBps: 300,
  maxFeeLamports: 10_000_000n,
} as const;

export function usdcMintForNetwork(network: string): string | null {
  return network === "mainnet" ? USDC_MINT : network === "devnet" ? DEVNET_USDC_MINT : null;
}
