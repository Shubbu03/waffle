import { expect, test } from "bun:test";
import type { HttpTransport } from "@waffle/http";
import { MarketRpc } from "@waffle/market-data/rpc";
import { RpcRemoteError } from "@waffle/market-data/rpc-scheduler";
import { WRAPPED_SOL_MINT } from "@waffle/shared";

test("market reads use confirmed RPC, matching IDs and a shared bounded transport", async () => {
  const calls: Array<{ method: string; params: unknown[]; id: number }> = [];
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "getBlockTime" ? 1800000000 : {} });
  }) as HttpTransport;
  const rpc = new MarketRpc({ url: "https://rpc.example", requestsPerSecond: 10, transport });
  try {
    await rpc.getTransaction("1".repeat(64));
    await rpc.getMultipleAccounts([WRAPPED_SOL_MINT], 123);
    await rpc.getBlockTime(123);
    expect(calls.map((call) => call.id)).toEqual([1, 2, 3]);
    expect(calls[0]?.params[1]).toEqual({
      commitment: "confirmed",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    });
    expect(calls[1]?.params[1]).toEqual({ commitment: "confirmed", encoding: "base64", minContextSlot: 123 });
    await expect(rpc.getBlockTime(-1)).rejects.toThrow("Invalid slot");
    expect(() => rpc.getMultipleAccounts([], 0)).toThrow("Invalid account request");
    expect(calls).toHaveLength(3);
  } finally {
    rpc.close();
  }
});

test("RPC errors and mismatched response IDs cannot become evidence", async () => {
  for (const malformed of [false, true]) {
    const transport = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json(
        malformed
          ? { jsonrpc: "2.0", id: body.id + 1, result: {} }
          : { jsonrpc: "2.0", id: body.id, error: { code: -32015, message: "secret-provider-detail" } },
      );
    }) as HttpTransport;
    const rpc = new MarketRpc({ url: "https://rpc.example", requestsPerSecond: 10, transport });
    try {
      await expect(rpc.getTransaction("1".repeat(64))).rejects.toThrow(
        malformed ? "Invalid RPC response" : RpcRemoteError,
      );
    } finally {
      rpc.close();
    }
  }
});
