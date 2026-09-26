import { transactionSignatureSchema } from "@waffle/shared";
import { z } from "zod";

export type WatcherSocket = Pick<
  WebSocket,
  "onopen" | "onclose" | "onerror" | "onmessage" | "send" | "ping" | "terminate"
>;
export type SocketFactory = (url: string) => WatcherSocket;
const slot = z.number().int().nonnegative().safe();
const notification = z.discriminatedUnion("method", [
  z.object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("slotNotification"),
    params: z.object({ subscription: slot, result: z.object({ slot }) }),
  }),
  z.object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("logsNotification"),
    params: z.object({
      subscription: slot,
      result: z.object({
        context: z.object({ slot }),
        value: z.object({ signature: transactionSignatureSchema, err: z.unknown().refine((v) => v !== undefined) }),
      }),
    }),
  }),
]);
const response = z.object({
  jsonrpc: z.literal("2.0"),
  id: slot,
  result: z.union([slot, z.boolean()]).optional(),
  error: z.unknown().optional(),
});
type Request = { method: "logsSubscribe" | "logsUnsubscribe" | "slotSubscribe"; wallet?: string; at: number };

/** One failure domain. tick() drives deadlines without creating a timer per subscription. */
export class WatcherConnection {
  readonly wallets = new Set<string>();
  private socket: WatcherSocket | undefined;
  private readonly pending = new Map<number, Request>();
  private readonly subscriptions = new Map<number, string>();
  private slotSubscription: number | undefined;
  private requestId = 0;
  private openedAt = 0;
  private lastPingAt = 0;
  private lastSlotAt = 0;
  private deadline = 0;
  private attempt = 0;
  private retryAt = 0;
  private stopped = false;
  state: "connecting" | "open" | "backoff" | "stopped" = "backoff";
  latestSlot = 0;
  generation = 0;

  constructor(
    readonly id: number,
    private readonly options: {
      url: string;
      socketFactory: SocketFactory;
      now: () => number;
      random: () => number;
      onDisconnect: () => void;
      onSubscribed: (wallet: string) => void;
      onLog: (wallet: string, signature: string, slot: number) => void;
    },
  ) {}

  get status() {
    return {
      id: this.id,
      state: this.state,
      slot: this.latestSlot,
      wallets: this.wallets.size,
      retryAt: this.retryAt,
      attempt: this.attempt,
    };
  }
  hasSubscription(wallet: string): boolean {
    return [...this.subscriptions.values()].includes(wallet);
  }

  add(wallet: string): void {
    this.wallets.add(wallet);
    if (this.state === "open")
      this.send("logsSubscribe", [{ mentions: [wallet] }, { commitment: "processed" }], wallet);
  }

  remove(wallet: string): void {
    this.wallets.delete(wallet);
    for (const request of this.pending.values()) {
      if (request.wallet === wallet) delete request.wallet;
    }
    for (const [id, address] of this.subscriptions) {
      if (address !== wallet) continue;
      this.subscriptions.delete(id);
      this.send("logsUnsubscribe", [id]);
    }
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.options.now();
    if (this.state === "backoff" && now >= this.retryAt) this.connect();
    if (this.state === "connecting" && now >= this.deadline) this.disconnect();
    if (this.state !== "open") return;
    if (now - this.lastSlotAt >= 30_000 || [...this.pending.values()].some((request) => now - request.at >= 15_000)) {
      this.disconnect();
      return;
    }
    if (now - this.openedAt >= 60_000) this.attempt = 0;
    if (now - this.lastPingAt >= 60_000) {
      this.lastPingAt = now;
      try {
        this.socket?.ping();
      } catch {
        this.disconnect();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.disconnect();
    this.state = "stopped";
  }

  private connect(): void {
    this.state = "connecting";
    this.deadline = this.options.now() + 15_000;
    try {
      const socket = this.options.socketFactory(this.options.url);
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.state = "open";
        this.openedAt = this.lastPingAt = this.lastSlotAt = this.options.now();
        this.send("slotSubscribe", []);
        for (const wallet of this.wallets)
          this.send("logsSubscribe", [{ mentions: [wallet] }, { commitment: "processed" }], wallet);
      };
      socket.onclose = socket.onerror = () => {
        if (this.socket === socket) this.disconnect();
      };
      socket.onmessage = (event) => {
        if (this.socket === socket) this.receive(event.data);
      };
    } catch {
      this.disconnect();
    }
  }

  private disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.terminate();
    }
    this.pending.clear();
    this.subscriptions.clear();
    this.slotSubscription = undefined;
    this.latestSlot = 0;
    this.generation++;
    this.state = "backoff";
    this.retryAt =
      this.options.now() +
      Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) +
      Math.floor(this.options.random() * 1000);
    this.options.onDisconnect();
  }

  private send(method: Request["method"], params: unknown[], wallet?: string): void {
    if (this.state !== "open") return;
    const id = ++this.requestId;
    this.pending.set(id, { method, at: this.options.now(), ...(wallet ? { wallet } : {}) });
    try {
      this.socket?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch {
      this.disconnect();
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== "string" || data.length > 1_048_576) {
      this.disconnect();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      this.disconnect();
      return;
    }
    const reply = response.safeParse(value);
    if (reply.success) {
      const request = this.pending.get(reply.data.id);
      if (!request) return;
      this.pending.delete(reply.data.id);
      const result = reply.data.result;
      if (
        reply.data.error !== undefined ||
        (request.method === "logsUnsubscribe" ? result !== true : typeof result !== "number")
      ) {
        this.disconnect();
        return;
      }
      if (typeof result !== "number") return;
      if (request.method === "slotSubscribe") this.slotSubscription = result;
      if (request.method === "logsSubscribe") {
        if (!request.wallet || !this.wallets.has(request.wallet)) {
          this.send("logsUnsubscribe", [result]);
          return;
        }
        this.subscriptions.set(result, request.wallet);
        this.options.onSubscribed(request.wallet);
      }
      return;
    }
    const parsed = notification.safeParse(value);
    if (!parsed.success) {
      this.disconnect();
      return;
    }
    const message = parsed.data;
    if (message.method === "slotNotification") {
      if (message.params.subscription !== this.slotSubscription) return;
      if (message.params.result.slot > this.latestSlot) {
        this.latestSlot = message.params.result.slot;
        this.lastSlotAt = this.options.now();
      }
      return;
    }
    const wallet = this.subscriptions.get(message.params.subscription);
    if (wallet && this.wallets.has(wallet) && message.params.result.value.err === null) {
      this.options.onLog(wallet, message.params.result.value.signature, message.params.result.context.slot);
    }
  }
}
