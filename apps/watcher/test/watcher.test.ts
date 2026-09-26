import { afterEach, describe, expect, test } from "bun:test";
import { PUMP_SWAP_PROGRAM_ID } from "@waffle/shared";
import { parseWatcherEnv } from "../src/config.ts";
import type { SocketFactory, WatcherSocket } from "../src/connection.ts";
import type { BackfillSignature, TransactionOutcome } from "../src/rpc.ts";
import { WalletWatcher, type WatcherEvent } from "../src/watcher.ts";

const wallets = ["1".repeat(32), `${"1".repeat(31)}2`, `${"1".repeat(31)}3`];
const firstWallet = wallets[0] as string;
const secondWallet = wallets[1] as string;
function signature(n: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = Math.max(1, Math.ceil(Math.log2(n + 1) / 8));
  let encoded = "";
  do {
    encoded = alphabet[n % 58] + encoded;
    n = Math.floor(n / 58);
  } while (n);
  return "1".repeat(64 - bytes) + encoded;
}
function entry(n: number): BackfillSignature {
  return { signature: signature(n), slot: n, err: null };
}
type Request = { id: number; method: string; params: unknown[] };

class FakeSocket implements WatcherSocket {
  onopen: WebSocket["onopen"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  requests: Request[] = [];
  pings = 0;
  terminated = false;
  private nextSubscription = 100;
  private subscriptions = new Map<string, number>();
  send(data: string): void {
    this.requests.push(JSON.parse(data) as Request);
  }
  ping(): void {
    this.pings++;
  }
  terminate(): void {
    this.terminated = true;
  }
  open(): void {
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }
  drop(): void {
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent("close"));
  }
  raw(data: string): void {
    this.onmessage?.call(this as unknown as WebSocket, new MessageEvent("message", { data }));
  }
  message(value: unknown): void {
    this.raw(JSON.stringify(value));
  }
  ackAll(): void {
    for (const request of this.requests.splice(0)) {
      const id = this.nextSubscription++;
      if (request.method === "logsSubscribe")
        this.subscriptions.set((request.params[0] as { mentions: string[] }).mentions[0] as string, id);
      if (request.method === "slotSubscribe") this.subscriptions.set("slot", id);
      this.message({ jsonrpc: "2.0", id: request.id, result: request.method === "logsUnsubscribe" ? true : id });
    }
  }
  slot(slot: number): void {
    this.message({
      jsonrpc: "2.0",
      method: "slotNotification",
      params: { subscription: this.subscriptions.get("slot"), result: { slot, parent: slot - 1, root: slot - 2 } },
    });
  }
  log(wallet: string, n: number, err: unknown = null, slot = n): void {
    this.message({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: this.subscriptions.get(wallet),
        result: { context: { slot }, value: { signature: signature(n), err, logs: [] } },
      },
    });
  }
}

const running: WalletWatcher[] = [];
afterEach(() => {
  for (const watcher of running.splice(0)) watcher.stop();
});
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function setup(count: 2 | 3 = 2) {
  let now = 1000;
  let currentSlot = 100;
  let active = wallets.slice(0, 2);
  let catalogFails = false;
  const sockets: FakeSocket[] = [];
  const events: WatcherEvent[] = [];
  let sinkFails = false;
  const calls: { wallet: string; signature: string; source: string }[] = [];
  const pages: { wallet: string; before?: string }[] = [];
  const history = new Map<string, BackfillSignature[]>(active.map((wallet) => [wallet, [entry(1)]]));
  let transaction: (wallet: string, signature: string) => Promise<TransactionOutcome> = async (wallet, signature) => ({
    status: "ignored",
    wallet,
    signature,
    reason: "invalid-transaction",
  });
  const watcher = new WalletWatcher({
    url: "wss://example.test/?api-key=private",
    connectionCount: count,
    staleSlots: 10,
    now: () => now,
    random: () => 0,
    socketFactory: (() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }) satisfies SocketFactory,
    loadActiveWallets: async () => {
      if (catalogFails) throw new Error("private-db-url");
      return active;
    },
    onEvent: (event) => {
      if (sinkFails) throw new Error("Sink unavailable");
      events.push(event);
    },
    rpc: {
      status: { degraded: false, queued: 0, provisionalQueued: 0, inFlight: 0, droppedProvisional: 0 },
      async getSignaturesForAddress(wallet, options = {}) {
        pages.push({ wallet, ...(options.before ? { before: options.before } : {}) });
        const all = history.get(wallet) ?? [];
        const start = options.before ? all.findIndex((e) => e.signature === options.before) + 1 : 0;
        return all.slice(start, start + (options.limit ?? 50));
      },
      queueTransaction(wallet, signature, source) {
        calls.push({ wallet, signature, source });
        return transaction(wallet, signature);
      },
    },
  });
  running.push(watcher);
  return {
    watcher,
    sockets,
    events,
    calls,
    pages,
    history,
    advance(ms: number, keepAlive = false) {
      now += ms;
      if (keepAlive) {
        currentSlot = Math.max(currentSlot, ...watcher.status.connections.map((connection) => connection.slot)) + 1;
        sockets
          .filter((s) => !s.terminated)
          .forEach((s) => {
            s.slot(currentSlot);
          });
      }
      watcher.tick();
    },
    setActive(value: string[]) {
      active = value;
    },
    failSink(value: boolean) {
      sinkFails = value;
    },
    failCatalog(value: boolean) {
      catalogFails = value;
    },
    setTransaction(value: typeof transaction) {
      transaction = value;
    },
    async start() {
      await watcher.start();
      for (const socket of sockets) {
        socket.open();
        socket.ackAll();
        socket.slot(100);
      }
      await settle();
    },
  };
}

describe("catalog watcher", () => {
  test("balances two or three connections and dedupes live overlap with confirmed recovery", async () => {
    const h = setup(3);
    h.setActive(wallets);
    await h.start();
    expect(h.sockets).toHaveLength(3);
    expect(h.watcher.status.connections.map((c) => c.wallets)).toEqual([1, 1, 1]);
    h.sockets[0]?.log(firstWallet, 2);
    h.sockets[0]?.log(firstWallet, 2);
    await settle();
    h.history.set(firstWallet, [entry(2), entry(1)]);
    h.sockets.forEach((socket) => {
      socket.slot(101);
    });
    h.advance(30_000, true);
    await settle();
    expect(h.calls.filter((call) => call.wallet === firstWallet && call.signature === signature(2))).toHaveLength(1);
    expect(
      h.events.filter((event) => event.outcome.wallet === firstWallet && event.outcome.signature === signature(2)),
    ).toHaveLength(1);
  });

  test("one failed connection leaves the other live; reconnect recovers multiple pages oldest first", async () => {
    const h = setup();
    await h.start();
    expect(h.watcher.status.wallets.every((w) => !w.stale)).toBe(true);
    h.sockets[0]?.drop();
    expect(h.watcher.status.wallets.map((w) => w.stale)).toEqual([true, false]);
    h.sockets[1]?.log(secondWallet, 101);
    await settle();
    expect(h.events.at(-1)).toMatchObject({ outcome: { wallet: secondWallet }, stale: false });
    h.history.set(
      firstWallet,
      Array.from({ length: 76 }, (_, i) => entry(76 - i)),
    );
    h.advance(1000);
    expect(h.sockets).toHaveLength(3);
    const replacement = h.sockets[2];
    replacement?.open();
    replacement?.ackAll();
    replacement?.slot(102);
    replacement?.log(firstWallet, 76, null, 102);
    await settle();
    expect(h.sockets[1]?.terminated).toBe(false);
    expect(h.pages.filter((page) => page.before)).toHaveLength(1);
    expect(h.calls.filter((call) => call.wallet === firstWallet && call.signature === signature(76))).toHaveLength(1);
    const recovered = h.events.filter((e) => e.outcome.wallet === firstWallet && e.source === "backfill");
    expect(recovered[1]?.outcome.signature).toBe(signature(2));
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: false, checkpoint: signature(76), error: null });
  });

  test("does not advance the cursor over failed or not-ready work; periodic recovery retries", async () => {
    const h = setup();
    await h.start();
    h.history.set(firstWallet, [entry(3), entry(2), entry(1)]);
    h.setTransaction(async (wallet, sig) => ({
      status: sig === signature(2) ? "not-ready" : "dropped",
      wallet,
      signature: sig,
    }));
    h.sockets[0]?.log(firstWallet, 2);
    await settle();
    h.sockets.forEach((socket) => {
      socket.slot(101);
    });
    h.advance(30_000, true);
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: true, checkpoint: signature(1) });
    h.setTransaction(async (wallet, sig) => ({
      status: "ignored",
      wallet,
      signature: sig,
      reason: "invalid-transaction",
    }));
    // Keep slot streams alive across the maintenance interval.
    h.sockets.forEach((socket) => {
      socket.slot(102);
    });
    h.advance(29_000);
    h.sockets.forEach((socket) => {
      socket.slot(103);
    });
    h.advance(1000);
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: false, checkpoint: signature(3) });
    expect(h.events.filter((e) => e.outcome.signature === signature(2))).toHaveLength(1);
  });

  test("marks slot lag stale without treating quiet wallets as stale", async () => {
    const h = setup();
    await h.start();
    h.sockets[1]?.slot(120);
    expect(h.watcher.status.wallets.map((w) => w.stale)).toEqual([true, false]);
    h.sockets[0]?.slot(119);
    expect(h.watcher.status.wallets.every((w) => !w.stale)).toBe(true);
  });

  test("pausing unsubscribes and suppresses in-flight work, late notifications and reconnect subscriptions", async () => {
    const h = setup();
    await h.start();
    let finish: ((outcome: TransactionOutcome) => void) | undefined;
    h.setTransaction(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.sockets[0]?.log(firstWallet, 2);
    await settle();
    h.setActive([secondWallet]);
    await h.watcher.refreshCatalog();
    expect(h.sockets[0]?.requests.at(-1)?.method).toBe("logsUnsubscribe");
    finish?.({ status: "ignored", wallet: firstWallet, signature: signature(2), reason: "invalid-transaction" });
    h.sockets[0]?.log(firstWallet, 3);
    await settle();
    expect(h.events.filter((e) => e.outcome.wallet === firstWallet)).toHaveLength(1);
    expect(h.calls.some((call) => call.signature === signature(3))).toBe(false);
    h.sockets[0]?.drop();
    h.advance(1000);
    h.sockets[2]?.open();
    expect(h.sockets[2]?.requests.map((r) => r.method)).toEqual(["slotSubscribe"]);
  });

  test("late subscription acknowledgement after pause is unsubscribed", async () => {
    const h = setup();
    await h.watcher.start();
    h.sockets[0]?.open();
    h.setActive([secondWallet]);
    await h.watcher.refreshCatalog();
    h.sockets[0]?.ackAll();
    expect(h.sockets[0]?.requests.at(-1)?.method).toBe("logsUnsubscribe");
  });

  test("missing cursor never silently skips history", async () => {
    const h = setup();
    await h.start();
    h.history.set(firstWallet, [entry(5), entry(4)]);
    h.sockets.forEach((socket) => {
      socket.slot(101);
    });
    h.advance(29_000);
    h.sockets.forEach((socket) => {
      socket.slot(102);
    });
    h.advance(1000);
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: true, error: "history-gap", checkpoint: signature(1) });
  });

  test("catalog failure exposes degraded status without leaking the error; successful refresh recovers", async () => {
    const h = setup();
    await h.start();
    h.failCatalog(true);
    await h.watcher.refreshCatalog();
    expect(h.watcher.status).toMatchObject({ catalogHealthy: false, degraded: true });
    expect(JSON.stringify(h.watcher.status)).not.toContain("private-db-url");
    h.failCatalog(false);
    await h.watcher.refreshCatalog();
    expect(h.watcher.status.degraded).toBe(false);
  });

  test("ignores failed transactions and rejects malformed frames on only their connection", async () => {
    const h = setup();
    await h.start();
    h.sockets[0]?.log(firstWallet, 9, { InstructionError: [0, "failed"] });
    expect(h.calls.some((call) => call.signature === signature(9))).toBe(false);
    h.sockets[0]?.raw("not-json");
    expect(h.sockets[0]?.terminated).toBe(true);
    expect(h.sockets[1]?.terminated).toBe(false);
  });

  test("heartbeats ping each minute; silent streams reconnect and backoff doubles independently", async () => {
    const h = setup();
    await h.start();
    for (let i = 0; i < 6; i++) {
      h.sockets.forEach((socket) => {
        socket.slot(101 + i);
      });
      h.advance(10_000);
      await settle();
    }
    expect(h.sockets.map((socket) => socket.pings)).toEqual([1, 1]);
    h.sockets[1]?.slot(110);
    h.advance(20_000);
    expect(h.watcher.status.connections.map((c) => c.state)).toEqual(["backoff", "open"]);
    h.advance(1000);
    h.sockets[2]?.drop();
    const failed = h.watcher.status.connections[0];
    expect(failed?.attempt).toBe(2);
    h.advance(1000);
    expect(h.sockets).toHaveLength(3);
    h.advance(1000);
    expect(h.sockets).toHaveLength(4);
  });

  test("subscription errors and acknowledgement timeouts reconnect only the affected lane", async () => {
    const h = setup();
    await h.watcher.start();
    h.sockets[0]?.open();
    h.sockets[1]?.open();
    h.sockets[1]?.ackAll();
    h.sockets[1]?.slot(100);
    const request = h.sockets[0]?.requests[0];
    h.sockets[0]?.message({ jsonrpc: "2.0", id: request?.id, error: { code: -32000, message: "private" } });
    expect(h.watcher.status.connections[0]?.state).toBe("backoff");
    h.advance(1000);
    h.sockets[2]?.open();
    h.advance(15_000);
    expect(h.sockets[2]?.terminated).toBe(true);
    expect(h.sockets[1]?.terminated).toBe(false);
  });

  test("a failing consumer retries the same result without fetching or losing the event", async () => {
    const h = setup();
    await h.start();
    h.failSink(true);
    h.sockets[0]?.log(firstWallet, 2, null, 100);
    await settle();
    h.history.set(firstWallet, [entry(2), entry(1)]);
    h.advance(30_000, true);
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: true, checkpoint: signature(1) });
    h.failSink(false);
    h.advance(30_000, true);
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: false, checkpoint: signature(2) });
    expect(h.calls.filter((call) => call.wallet === firstWallet && call.signature === signature(2))).toHaveLength(1);
    expect(
      h.events.filter((event) => event.outcome.wallet === firstWallet && event.outcome.signature === signature(2)),
    ).toHaveLength(1);
    expect(h.events.find((event) => event.outcome.signature === signature(2))).toMatchObject({
      observedAtMs: 1000,
      source: "provisional",
      stale: true,
    });
  });

  test("recovery waits for a live fetch before advancing and retries if that fetch is not ready", async () => {
    const h = setup();
    await h.start();
    let finish: ((outcome: TransactionOutcome) => void) | undefined;
    h.setTransaction(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.sockets[0]?.log(firstWallet, 2, null, 100);
    await settle();
    h.history.set(firstWallet, [entry(2), entry(1)]);
    h.advance(30_000, true);
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ recovering: true, checkpoint: signature(1) });
    finish?.({ status: "not-ready", wallet: firstWallet, signature: signature(2) });
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: true, checkpoint: signature(1) });
    expect(h.calls.filter((call) => call.wallet === firstWallet && call.signature === signature(2))).toHaveLength(1);
  });

  test("recovery stops at its history budget and leaves a visible gap", async () => {
    const h = setup();
    await h.start();
    h.history.set(
      firstWallet,
      Array.from({ length: 5002 }, (_, i) => entry(5002 - i)),
    );
    h.advance(30_000, true);
    await settle();
    expect(h.watcher.status.wallets[0]).toMatchObject({ stale: true, error: "history-gap", checkpoint: signature(1) });
    expect(h.pages.filter((page) => page.wallet === firstWallet)).toHaveLength(101);
    expect(h.calls.filter((call) => call.wallet === firstWallet)).toHaveLength(1);
  });

  test("an old confirmed buy stays stale even when its socket is current", async () => {
    const h = setup();
    await h.start();
    h.setTransaction(async (wallet, sig) => ({
      status: "buy",
      wallet,
      signature: sig,
      transaction: {},
      buy: {
        wallet,
        signature: sig,
        slot: 1,
        sourceProgramId: PUMP_SWAP_PROGRAM_ID,
        poolAddress: secondWallet,
        mintAddress: secondWallet,
        baseAmountRaw: "1",
        quoteAmountLimitRaw: "1",
      },
    }));
    h.sockets[0]?.log(firstWallet, 2, null, 100);
    await settle();
    expect(h.watcher.status.wallets[0]?.stale).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ outcome: { status: "buy" }, stale: true });
  });

  test("stop prevents reconnection and catalog polling", async () => {
    const h = setup();
    await h.start();
    h.watcher.stop();
    h.advance(120_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets.every((socket) => socket.terminated)).toBe(true);
    expect(h.watcher.status.running).toBe(false);
  });
});

test("watcher environment accepts only secure URLs and two or three connections with sanitized errors", () => {
  const env = {
    JUPITER_API_KEY: "private",
    HELIUS_RPC_URL: "https://rpc.test/?api-key=private",
    HELIUS_WSS_URL: "wss://rpc.test/?api-key=private",
    DATABASE_URL: "postgresql://private@db.test/waffle",
  };
  expect(parseWatcherEnv(env)).toMatchObject({
    WATCHER_CONNECTIONS: 2,
    WATCHER_STALE_SLOTS: 150,
    WATCHER_STATUS_PORT: 3002,
  });
  for (const overrides of [
    { WATCHER_CONNECTIONS: "4" },
    { HELIUS_WSS_URL: "ws://rpc.test/private" },
    { WATCHER_STALE_SLOTS: "0" },
    { DATABASE_URL: "https://private.test" },
  ]) {
    expect(() => parseWatcherEnv({ ...env, ...overrides })).toThrow("Invalid watcher environment");
    try {
      parseWatcherEnv({ ...env, ...overrides });
    } catch (error) {
      expect(String(error)).not.toContain("private");
    }
  }
});
