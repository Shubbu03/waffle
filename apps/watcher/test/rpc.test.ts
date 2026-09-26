import { describe, expect, test } from "bun:test";
import { parseWatcherRpcEnv } from "../src/config.ts";
import { WatcherRpc } from "../src/rpc.ts";
import { RpcHttpError, RpcScheduler, RpcTimeoutError } from "../src/rpc-scheduler.ts";

const wallet = "1".repeat(32);
const otherWallet = `${"1".repeat(31)}2`;
const signature = "1".repeat(64);
const rpcUrl = "https://rpc.example.test/?api-key=test-only";

type RpcRequest = { id: number; method: string; params: unknown[] };

function fakeFetch(handler: (request: RpcRequest) => unknown | Promise<unknown>): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    const result = await handler(request);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  }) as typeof fetch;
}

describe("RPC configuration", () => {
  test("uses the free-tier ceilings and hides the URL on errors", () => {
    expect(parseWatcherRpcEnv({ HELIUS_RPC_URL: rpcUrl })).toEqual({
      HELIUS_RPC_URL: rpcUrl,
      RPC_REQUESTS_PER_SECOND: 10,
      RPC_PROGRAM_ACCOUNTS_PER_SECOND: 5,
    });
    for (const env of [
      { HELIUS_RPC_URL: "http://rpc.example.test/?api-key=secret" },
      { HELIUS_RPC_URL: rpcUrl, RPC_REQUESTS_PER_SECOND: "11" },
      { HELIUS_RPC_URL: rpcUrl, RPC_PROGRAM_ACCOUNTS_PER_SECOND: "6" },
    ]) {
      try {
        parseWatcherRpcEnv(env);
        throw new Error("Expected configuration failure");
      } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    }
  });
});

describe("shared scheduler", () => {
  test("spaces every method to at most ten requests per rolling second", async () => {
    const scheduler = new RpcScheduler();
    const starts: number[] = [];
    const jobs = Array.from({ length: 11 }, (_, index) => {
      const method = index % 3 === 0 ? "getAccountInfo" : "getTransaction";
      const submitted = scheduler.submit(method, "evidence", async () => {
        starts.push(performance.now());
        return index;
      });
      if (!submitted.accepted) throw new Error("Unexpected drop");
      return submitted.result;
    });
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 11 }, (_, index) => index));
    const firstStart = starts[0];
    if (firstStart === undefined) throw new Error("Expected scheduler calls");
    let previousStart = firstStart;
    for (const start of starts.slice(1)) {
      expect(start - previousStart).toBeGreaterThanOrEqual(80);
      previousStart = start;
    }
    expect(previousStart - firstStart).toBeGreaterThanOrEqual(950);
    scheduler.close();
  });

  test("limits program-account calls separately without bypassing total budget", async () => {
    const scheduler = new RpcScheduler();
    const starts: number[] = [];
    const jobs = Array.from({ length: 6 }, (_, index) => {
      const submitted = scheduler.submit("getProgramAccounts", "evidence", async () => {
        starts.push(performance.now());
        return index;
      });
      if (!submitted.accepted) throw new Error("Unexpected drop");
      return submitted.result;
    });
    await Promise.all(jobs);
    const firstStart = starts[0];
    if (firstStart === undefined) throw new Error("Expected scheduler calls");
    let previousStart = firstStart;
    for (const start of starts.slice(1)) {
      expect(start - previousStart).toBeGreaterThanOrEqual(180);
      previousStart = start;
    }
    scheduler.close();
  });

  test("reserves progress for backfill during a provisional burst", async () => {
    const scheduler = new RpcScheduler();
    const order: string[] = [];
    const jobs: Promise<unknown>[] = [];
    for (let index = 0; index < 8; index++) {
      const submitted = scheduler.submit("getTransaction", "provisional", async () => {
        order.push("provisional");
      });
      if (!submitted.accepted) throw new Error("Unexpected drop");
      jobs.push(submitted.result);
    }
    const backfill = scheduler.submit("getSignaturesForAddress", "backfill", async () => {
      order.push("backfill");
    });
    if (!backfill.accepted) throw new Error("Unexpected drop");
    jobs.push(backfill.result);
    await Promise.all(jobs);
    expect(order.indexOf("backfill")).toBeLessThanOrEqual(4);
    scheduler.close();
  });

  test("retries transient failures once through the same budget and times out hung calls", async () => {
    const scheduler = new RpcScheduler({ timeoutMs: 20, retryDelayMs: 0 });
    let attempts = 0;
    const submitted = scheduler.submit("getTransaction", "provisional", async () => {
      attempts++;
      if (attempts === 1) throw new RpcHttpError(429);
      return "ok";
    });
    if (!submitted.accepted) throw new Error("Unexpected drop");
    expect(await submitted.result).toBe("ok");
    expect(attempts).toBe(2);

    let timeouts = 0;
    const hung = scheduler.submit("getAccountInfo", "evidence", async () => {
      timeouts++;
      return new Promise<never>(() => {});
    });
    if (!hung.accepted) throw new Error("Unexpected drop");
    await expect(hung.result).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(timeouts).toBe(2);

    let permanentAttempts = 0;
    const permanent = scheduler.submit("getAccountInfo", "evidence", async () => {
      permanentAttempts++;
      throw new RpcHttpError(400);
    });
    if (!permanent.accepted) throw new Error("Unexpected drop");
    await expect(permanent.result).rejects.toBeInstanceOf(RpcHttpError);
    expect(permanentAttempts).toBe(1);
    scheduler.close();
  });

  test("closing cancels an active call", async () => {
    const scheduler = new RpcScheduler();
    const submitted = scheduler.submit("getAccountInfo", "evidence", async () => new Promise<never>(() => {}));
    if (!submitted.accepted) throw new Error("Unexpected drop");
    scheduler.close();
    await expect(submitted.result).rejects.toThrow("RPC scheduler closed");
  });

  test("drops provisional work beyond fifty queued items and exposes degraded status", async () => {
    const scheduler = new RpcScheduler({ timeoutMs: 20, retryDelayMs: 0 });
    const jobs: Promise<unknown>[] = [];
    for (let index = 0; index < 52; index++) {
      const submitted = scheduler.submit("getTransaction", "provisional", async () => new Promise<never>(() => {}));
      if (submitted.accepted) jobs.push(submitted.result.catch(() => undefined));
      else expect(index).toBe(51);
    }
    expect(scheduler.status).toMatchObject({
      degraded: true,
      provisionalQueued: 50,
      droppedProvisional: 1,
    });
    scheduler.close();
    await Promise.all(jobs);
  });
});

describe("watcher RPC client", () => {
  test("requests jsonParsed and exposes only classified buys", async () => {
    const transaction = await Bun.file(new URL("../../../tests/fixtures/pumpswap-buy.json", import.meta.url)).json();
    const signer = transaction.transaction.message.accountKeys.find((key: { signer: boolean }) => key.signer)
      .pubkey as string;
    const txSignature = transaction.transaction.signatures[0] as string;
    let encoding: unknown;
    const rpc = new WatcherRpc({
      url: rpcUrl,
      fetchImpl: fakeFetch((request) => {
        encoding = (request.params[1] as { encoding?: unknown }).encoding;
        return transaction;
      }),
    });
    const result = await rpc.queueTransaction(signer, txSignature, "provisional");
    expect(encoding).toBe("jsonParsed");
    expect(result).toMatchObject({ status: "buy", buy: { wallet: signer, baseAmountRaw: "392237471" } });
    rpc.close();
  });

  test("dedupes provisional events and overlapping backfill before transaction fetch", async () => {
    const methods: string[] = [];
    const rpc = new WatcherRpc({
      url: rpcUrl,
      fetchImpl: fakeFetch((request) => {
        methods.push(request.method);
        if (request.method === "getSignaturesForAddress")
          return [
            { signature, slot: 123, err: null },
            { signature: `${"1".repeat(63)}2`, slot: 122, err: { InstructionError: [0, "failed"] } },
          ];
        if (request.method === "getTransaction") return { slot: 123, meta: { err: null } };
        throw new Error("Unexpected method");
      }),
    });
    const first = rpc.queueTransaction(wallet, signature, "provisional");
    const duplicate = rpc.queueTransaction(wallet, signature, "provisional");
    expect((await duplicate).status).toBe("duplicate");
    const backfill = rpc.backfill(wallet);
    expect(await first).toMatchObject({ status: "ignored", reason: "invalid-transaction" });
    expect((await backfill)[0]?.status).toBe("duplicate");
    expect((await rpc.queueTransaction(wallet, signature, "provisional")).status).toBe("duplicate");
    expect(methods.filter((method) => method === "getTransaction")).toHaveLength(1);
    expect(methods.filter((method) => method === "getSignaturesForAddress")).toHaveLength(1);
    rpc.close();
  });

  test("routes token, pool, and program checks through the same scheduler", async () => {
    const methods: string[] = [];
    const rpc = new WatcherRpc({
      url: rpcUrl,
      fetchImpl: fakeFetch((request) => {
        methods.push(request.method);
        return { value: null };
      }),
    });
    await Promise.all([rpc.getTokenAccount(wallet), rpc.getPoolAccount(otherWallet), rpc.getProgramAccounts(wallet)]);
    expect(methods.sort()).toEqual(["getAccountInfo", "getAccountInfo", "getProgramAccounts"]);
    rpc.close();
  });

  test("does not cache a not-ready transaction and retries on a later sighting", async () => {
    let calls = 0;
    const rpc = new WatcherRpc({
      url: rpcUrl,
      retryDelayMs: 0,
      fetchImpl: fakeFetch((request) => {
        if (request.method !== "getTransaction") throw new Error("Unexpected method");
        calls++;
        return calls <= 2 ? null : { slot: 456 };
      }),
    });
    expect((await rpc.queueTransaction(wallet, signature, "provisional")).status).toBe("not-ready");
    expect((await rpc.queueTransaction(wallet, signature, "backfill")).status).toBe("ignored");
    expect(calls).toBe(3);
    rpc.close();
  });
});

test("in-flight duplicates wait for confirmation and propagate retryable outcomes", async () => {
  const rpc = new WatcherRpc({ url: rpcUrl, retryDelayMs: 0, fetchImpl: fakeFetch(() => null) });
  const original = rpc.queueTransaction(wallet, signature, "provisional");
  const recovery = rpc.queueTransaction(wallet, signature, "backfill");
  expect((await original).status).toBe("not-ready");
  expect((await recovery).status).toBe("not-ready");
  rpc.close();
});
