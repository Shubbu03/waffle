import { solanaAddressSchema, transactionSignatureSchema } from "@waffle/shared";
import { parseWatcherRpcEnv } from "./config.ts";
import {
  RpcHttpError,
  type RpcMethod,
  RpcNotReadyError,
  RpcProvisionalDroppedError,
  RpcRemoteError,
  RpcScheduler,
  type RpcSchedulerOptions,
} from "./rpc-scheduler.ts";

export type TransactionOutcome =
  | { status: "fetched"; wallet: string; signature: string; transaction: unknown }
  | { status: "not-ready"; wallet: string; signature: string }
  | { status: "dropped"; wallet: string; signature: string }
  | { status: "duplicate"; wallet: string; signature: string };

export type BackfillSignature = { signature: string; slot: number; err: unknown };

type RpcOptions = RpcSchedulerOptions & {
  url: string;
  fetchImpl?: typeof fetch;
  dedupeTtlMs?: number;
  maxRemembered?: number;
};

function parseSignatures(value: unknown): BackfillSignature[] {
  if (!Array.isArray(value)) throw new Error("Invalid backfill RPC response");
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object") throw new Error("Invalid backfill RPC entry");
    const record = entry as Record<string, unknown>;
    const signature = transactionSignatureSchema.parse(record.signature);
    if (!Object.hasOwn(record, "err")) throw new Error("Invalid backfill RPC error field");
    if (!Number.isSafeInteger(record.slot) || (record.slot as number) < 0) {
      throw new Error("Invalid backfill RPC slot");
    }
    return { signature, slot: record.slot as number, err: record.err ?? null };
  });
}

/** Owns the only RPC transport and scheduler used by a watcher process. */
export class WatcherRpc {
  readonly scheduler: RpcScheduler;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dedupeTtlMs: number;
  private readonly maxRemembered: number;
  private requestId = 0;
  private readonly pendingTransactions = new Set<string>();
  private readonly completedTransactions = new Map<string, number>();

  constructor(options: RpcOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new Error("Invalid RPC URL");
    }
    if (url.protocol !== "https:") throw new Error("RPC URL must use HTTPS");
    this.url = url.toString();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.scheduler = new RpcScheduler(options);
    this.dedupeTtlMs = options.dedupeTtlMs ?? 300_000;
    this.maxRemembered = options.maxRemembered ?? 10_000;
    if (
      !Number.isSafeInteger(this.dedupeTtlMs) ||
      this.dedupeTtlMs < 1 ||
      !Number.isSafeInteger(this.maxRemembered) ||
      this.maxRemembered < 1
    ) {
      throw new Error("Invalid RPC deduplication settings");
    }
  }

  get status() {
    return this.scheduler.status;
  }

  close(): void {
    this.scheduler.close();
  }

  /** Log and backfill sightings of the same (signature, wallet) share one fetch. */
  queueTransaction(wallet: string, signature: string, source: "provisional" | "backfill"): Promise<TransactionOutcome> {
    wallet = solanaAddressSchema.parse(wallet);
    signature = transactionSignatureSchema.parse(signature);
    const key = `${wallet}:${signature}`;
    if (this.pendingTransactions.has(key)) return Promise.resolve({ status: "duplicate", wallet, signature });
    const expiresAt = this.completedTransactions.get(key);
    if (expiresAt !== undefined) {
      if (expiresAt > Date.now()) return Promise.resolve({ status: "duplicate", wallet, signature });
      this.completedTransactions.delete(key);
    }

    const submitted = this.scheduler.submit("getTransaction", source, async (signal) => {
      const transaction = await this.call(
        "getTransaction",
        [
          signature,
          {
            commitment: "confirmed",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          },
        ],
        signal,
      );
      if (transaction === null) throw new RpcNotReadyError();
      return { status: "fetched", wallet, signature, transaction } satisfies TransactionOutcome;
    });
    if (!submitted.accepted) return Promise.resolve({ status: "dropped", wallet, signature });

    const result: Promise<TransactionOutcome> = submitted.result
      .catch((error: unknown) => {
        if (error instanceof RpcNotReadyError) return { status: "not-ready", wallet, signature } as const;
        if (error instanceof RpcProvisionalDroppedError) return { status: "dropped", wallet, signature } as const;
        throw error;
      })
      .then((outcome) => {
        if (outcome.status === "fetched") this.remember(key);
        return outcome;
      })
      .finally(() => {
        this.pendingTransactions.delete(key);
      });
    this.pendingTransactions.add(key);
    return result;
  }

  /** Backfill discovery uses the same budget; overlapping signatures reuse in-flight or recent fetches. */
  async backfill(wallet: string, options: { before?: string; limit?: number } = {}): Promise<TransactionOutcome[]> {
    if (options.limit !== undefined && options.limit > 50)
      throw new Error("Backfill page must be at most 50 signatures");
    const signatures = await this.getSignaturesForAddress(wallet, options);
    return Promise.all(
      signatures
        .filter((entry) => entry.err === null)
        .map((entry) => Promise.resolve().then(() => this.queueTransaction(wallet, entry.signature, "backfill"))),
    );
  }

  async getSignaturesForAddress(
    wallet: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<BackfillSignature[]> {
    solanaAddressSchema.parse(wallet);
    if (options.before !== undefined) transactionSignatureSchema.parse(options.before);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Backfill limit must be 1 to 1000");
    const submitted = this.scheduler.submit("getSignaturesForAddress", "backfill", async (signal) => {
      const result = await this.call(
        "getSignaturesForAddress",
        [
          wallet,
          {
            commitment: "confirmed",
            limit,
            ...(options.before ? { before: options.before } : {}),
          },
        ],
        signal,
      );
      return parseSignatures(result);
    });
    if (!submitted.accepted) throw new Error("Backfill request was dropped");
    return submitted.result;
  }

  async getTokenAccount(address: string): Promise<unknown> {
    return this.getAccountInfo(address);
  }

  async getPoolAccount(address: string): Promise<unknown> {
    return this.getAccountInfo(address);
  }

  async getProgramAccounts(programId: string, filters: readonly unknown[] = []): Promise<unknown> {
    solanaAddressSchema.parse(programId);
    const submitted = this.scheduler.submit("getProgramAccounts", "evidence", (signal) =>
      this.call("getProgramAccounts", [programId, { commitment: "confirmed", encoding: "base64", filters }], signal),
    );
    if (!submitted.accepted) throw new Error("Program accounts request was dropped");
    return submitted.result;
  }

  private async getAccountInfo(address: string): Promise<unknown> {
    solanaAddressSchema.parse(address);
    const submitted = this.scheduler.submit("getAccountInfo", "evidence", (signal) =>
      this.call("getAccountInfo", [address, { commitment: "confirmed", encoding: "base64" }], signal),
    );
    if (!submitted.accepted) throw new Error("Account request was dropped");
    return submitted.result;
  }

  private remember(key: string): void {
    this.completedTransactions.delete(key);
    this.completedTransactions.set(key, Date.now() + this.dedupeTtlMs);
    while (this.completedTransactions.size > this.maxRemembered) {
      const oldest = this.completedTransactions.keys().next().value;
      if (oldest === undefined) break;
      this.completedTransactions.delete(oldest);
    }
  }

  private async call(method: RpcMethod, params: unknown[], signal: AbortSignal): Promise<unknown> {
    const id = ++this.requestId;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    if (!response.ok) throw new RpcHttpError(response.status);
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object") throw new Error("Invalid RPC response");
    const message = payload as Record<string, unknown>;
    if (message.jsonrpc !== "2.0" || message.id !== id) throw new Error("Invalid RPC response ID");
    if (message.error !== undefined) {
      const error = message.error;
      if (error === null || typeof error !== "object" || typeof (error as { code?: unknown }).code !== "number") {
        throw new Error("Invalid RPC error response");
      }
      throw new RpcRemoteError((error as { code: number }).code);
    }
    if (!Object.hasOwn(message, "result")) throw new Error("RPC result missing");
    return message.result;
  }
}

export function createWatcherRpc(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): WatcherRpc {
  const config = parseWatcherRpcEnv(env);
  return new WatcherRpc({
    url: config.HELIUS_RPC_URL,
    requestsPerSecond: config.RPC_REQUESTS_PER_SECOND,
    programAccountsPerSecond: config.RPC_PROGRAM_ACCOUNTS_PER_SECOND,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
