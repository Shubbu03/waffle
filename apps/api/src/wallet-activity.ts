import { createHttpClient, type HttpTransport } from "@waffle/http";
import { PUMP_SWAP_PROGRAM_ID, solanaAddressSchema } from "@waffle/shared";

/** Bound the per-track budget: 1 history page + at most this many body fetches. */
export const ACTIVITY_SAMPLE_SIZE = 5;
/** One page covers the last hour even for wallets up to 1000 tx/h (RPC maximum). */
export const ACTIVITY_HISTORY_LIMIT = 1000;
/** Wallets above this rate rarely stay caught up on the free tier; warn then reject. */
export const ACTIVITY_WARN_TX_PER_HOUR = 31;
export const ACTIVITY_REJECT_TX_PER_HOUR = 100;

export type WalletActivityVerdict =
  | { status: "ok"; txPerHour: number; warning?: "very-active" }
  | { status: "no-history" }
  | { status: "unsupported-wallet" }
  | { status: "too-active"; txPerHour: number };

export type WalletActivityValidator = { validate(address: string): Promise<WalletActivityVerdict> };

type RpcEntry = { signature?: unknown; err?: unknown; blockTime?: unknown };

/** True when the transaction invokes or references PumpSwap anywhere. */
function mentionsPumpSwap(transaction: unknown): boolean {
  if (transaction === null || typeof transaction !== "object") return false;
  const record = transaction as {
    transaction?: {
      message?: {
        accountKeys?: Array<{ pubkey?: string } | string>;
        instructions?: Array<{ programId?: string }>;
      };
    };
    meta?: { innerInstructions?: Array<{ instructions?: Array<{ programId?: string }> }> };
  };
  for (const key of record.transaction?.message?.accountKeys ?? []) {
    const pubkey = typeof key === "string" ? key : key?.pubkey;
    if (pubkey === PUMP_SWAP_PROGRAM_ID) return true;
  }
  if ((record.transaction?.message?.instructions ?? []).some((ix) => ix?.programId === PUMP_SWAP_PROGRAM_ID)) {
    return true;
  }
  for (const group of record.meta?.innerInstructions ?? []) {
    if ((group?.instructions ?? []).some((ix) => ix?.programId === PUMP_SWAP_PROGRAM_ID)) return true;
  }
  return false;
}

/**
 * Validates a pasted wallet before tracking: has history, trades the supported
 * family (PumpSwap), and is not too active to keep up with. Spends at most
 * 1 + ACTIVITY_SAMPLE_SIZE RPC calls, spaced to respect the shared rate budget.
 */
export function createWalletActivityValidator(options: {
  url: string;
  requestsPerSecond?: number;
  transport?: HttpTransport | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): WalletActivityValidator {
  const client = createHttpClient({
    timeoutMs: 8_000,
    maxResponseBytes: 2_000_000,
    ...(options.transport ? { transport: options.transport } : {}),
  });
  const spacingMs = Math.max(100, Math.ceil(1_000 / (options.requestsPerSecond ?? 10)));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastCallAt = 0;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const wait = spacingMs - (now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
    const response = await client.request({
      url: options.url,
      method: "POST",
      headers: { "content-type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`RPC HTTP ${response.status}`);
    const payload = response.data as { result?: unknown; error?: unknown } | null;
    if (payload === null || payload?.error !== undefined) throw new Error("RPC error response");
    return payload.result;
  }

  return {
    async validate(address: string): Promise<WalletActivityVerdict> {
      solanaAddressSchema.parse(address);
      const history = await rpc("getSignaturesForAddress", [
        address,
        { commitment: "confirmed", limit: ACTIVITY_HISTORY_LIMIT },
      ]);
      const entries = (Array.isArray(history) ? history : []).filter(
        (entry): entry is RpcEntry => entry !== null && typeof entry === "object",
      );
      if (entries.length === 0) return { status: "no-history" };

      const hourAgoMs = now() - 3_600_000;
      const txPerHour = entries.filter(
        (entry) => typeof entry.blockTime === "number" && entry.blockTime * 1_000 >= hourAgoMs,
      ).length;
      if (txPerHour > ACTIVITY_REJECT_TX_PER_HOUR) return { status: "too-active", txPerHour };

      let supported = false;
      const confirmed = entries.filter((entry) => entry.err === null && typeof entry.signature === "string");
      for (const entry of confirmed.slice(0, ACTIVITY_SAMPLE_SIZE)) {
        const transaction = await rpc("getTransaction", [
          entry.signature,
          { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);
        if (transaction !== null && mentionsPumpSwap(transaction)) {
          supported = true;
          break;
        }
      }
      if (!supported) return { status: "unsupported-wallet" };
      return txPerHour >= ACTIVITY_WARN_TX_PER_HOUR
        ? { status: "ok", txPerHour, warning: "very-active" }
        : { status: "ok", txPerHour };
    },
  };
}
