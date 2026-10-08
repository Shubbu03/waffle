import { createHttpClient, type HttpTransport } from "@waffle/http";
import { solanaAddressSchema, transactionSignatureSchema } from "@waffle/shared";
import { RpcHttpError, type RpcMethod, RpcRemoteError, RpcScheduler } from "./rpc-scheduler.ts";

/** Bounded Xior transport for market reads and explicitly requested Devnet broadcasts. Never signs. */
export class MarketRpc {
  private readonly client;
  private readonly scheduler: RpcScheduler;
  private id = 0;
  constructor(
    private readonly options: {
      url: string;
      requestsPerSecond: number;
      transport?: HttpTransport;
      scheduler?: RpcScheduler;
    },
  ) {
    if (new URL(options.url).protocol !== "https:") throw new Error("Expected HTTPS RPC");
    this.client = createHttpClient({ timeoutMs: 4000, maxResponseBytes: 2_000_000, transport: options.transport });
    this.scheduler =
      options.scheduler ?? new RpcScheduler({ requestsPerSecond: options.requestsPerSecond, maxConcurrent: 1 });
  }
  close() {
    this.scheduler.close();
  }
  async call(method: RpcMethod, params: unknown[]): Promise<unknown> {
    const submitted = this.scheduler.submit(method, "evidence", async (signal) => {
      const id = ++this.id;
      const response = await this.client.request({
        url: this.options.url,
        method: "POST",
        signal,
        data: { jsonrpc: "2.0", id, method, params },
      });
      if (response.status < 200 || response.status >= 300) throw new RpcHttpError(response.status);
      const body = response.data as {
        jsonrpc?: unknown;
        id?: unknown;
        result?: unknown;
        error?: { code?: unknown };
      } | null;
      if (body?.jsonrpc !== "2.0" || body.id !== id) throw new Error("Invalid RPC response");
      if (body.error !== undefined) {
        if (typeof body.error?.code === "number") throw new RpcRemoteError(body.error.code);
        throw new Error("Invalid RPC error");
      }
      if (!Object.hasOwn(body, "result")) throw new Error("Missing RPC result");
      return body.result;
    });
    if (!submitted.accepted) throw new Error("RPC capacity reached");
    return submitted.result;
  }
  getTransaction(signature: string) {
    transactionSignatureSchema.parse(signature);
    return this.call("getTransaction", [
      signature,
      { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
  }
  getMultipleAccounts(addresses: readonly string[], minContextSlot: number) {
    if (!addresses.length || addresses.length > 100 || !Number.isSafeInteger(minContextSlot) || minContextSlot < 0)
      throw new Error("Invalid account request");
    for (const address of addresses) solanaAddressSchema.parse(address);
    return this.call("getMultipleAccounts", [
      addresses,
      { commitment: "confirmed", encoding: "base64", minContextSlot },
    ]);
  }
  async getBlockTime(slot: number): Promise<number> {
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("Invalid slot");
    const value = await this.call("getBlockTime", [slot]);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid block time");
    return value;
  }
}
