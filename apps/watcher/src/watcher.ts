import { solanaAddressSchema } from "@waffle/shared";
import { type SocketFactory, WatcherConnection } from "./connection.ts";
import type { TransactionOutcome, WatcherRpc } from "./rpc.ts";

type CompletedOutcome = Extract<TransactionOutcome, { status: "buy" | "ignored" }>;
export type WatcherEvent = {
  outcome: CompletedOutcome;
  source: "provisional" | "backfill";
  stale: boolean;
  observedAtMs: number;
};
type Wallet = {
  address: string;
  connection: WatcherConnection;
  checkpoint: string | undefined;
  initialized: boolean;
  caughtUp: boolean;
  revision: number;
  recovering: boolean;
  nextRecoveryAt: number;
  error: "recovery-failed" | "history-gap" | null;
  completed: Set<string>;
  pending: Map<string, Promise<boolean>>;
  undelivered: Map<string, WatcherEvent>;
};
export type WalletWatcherOptions = {
  url: string;
  connectionCount?: 2 | 3;
  staleSlots?: number;
  rpc: Pick<WatcherRpc, "queueTransaction" | "getSignaturesForAddress" | "status">;
  loadActiveWallets: () => Promise<string[]>;
  onEvent: (event: WatcherEvent) => void | Promise<void>;
  socketFactory?: SocketFactory;
  now?: () => number;
  random?: () => number;
};

export class WalletWatcher {
  private readonly connections: WatcherConnection[];
  private readonly wallets = new Map<string, Wallet>();
  private readonly now: () => number;
  private readonly staleSlots: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private catalogLoading = false;
  private catalogHealthy = false;
  private nextCatalogAt = 0;

  constructor(private readonly options: WalletWatcherOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new Error("Invalid watcher WebSocket URL");
    }
    if (url.protocol !== "wss:") throw new Error("Watcher WebSocket URL must use WSS");
    const count = options.connectionCount ?? 2;
    if (count !== 2 && count !== 3) throw new Error("Watcher requires two or three connections");
    this.staleSlots = options.staleSlots ?? 150;
    if (!Number.isSafeInteger(this.staleSlots) || this.staleSlots < 1) throw new Error("Invalid stale slot threshold");
    this.now = options.now ?? Date.now;
    this.connections = Array.from(
      { length: count },
      (_, id) =>
        new WatcherConnection(id, {
          url: url.toString(),
          now: this.now,
          random: options.random ?? Math.random,
          socketFactory: options.socketFactory ?? ((url) => new WebSocket(url)),
          onDisconnect: () => {
            for (const wallet of this.wallets.values()) if (wallet.connection.id === id) this.invalidate(wallet);
          },
          onSubscribed: (address) => {
            const wallet = this.wallets.get(address);
            if (wallet) {
              wallet.nextRecoveryAt = 0;
              void this.recover(wallet);
            }
          },
          onLog: (address, signature, slot) => {
            const wallet = this.wallets.get(address);
            if (!wallet) return;
            if (this.headSlot - slot > this.staleSlots) this.invalidate(wallet);
            void this.process(wallet, signature, "provisional");
          },
        }),
    );
  }

  get status() {
    const wallets = [...this.wallets.values()].map((wallet) => ({
      address: wallet.address,
      connectionId: wallet.connection.id,
      stale: this.isStale(wallet),
      recovering: wallet.recovering,
      checkpoint: wallet.checkpoint ?? null,
      error: wallet.error,
    }));
    return {
      running: !this.stopped,
      degraded: !this.catalogHealthy || this.options.rpc.status.degraded || wallets.some((wallet) => wallet.stale),
      catalogHealthy: this.catalogHealthy,
      headSlot: this.headSlot,
      connections: this.connections.map((connection) => connection.status),
      wallets,
      rpc: this.options.rpc.status,
    };
  }

  async start(): Promise<void> {
    if (this.timer || this.stopped) throw new Error("Watcher already started or stopped");
    await this.refreshCatalog();
    if (this.stopped) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const connection of this.connections) connection.stop();
  }

  /** Public maintenance step also permits deterministic clock-driven failure tests. */
  tick(): void {
    if (this.stopped) return;
    for (const connection of this.connections) connection.tick();
    if (this.now() >= this.nextCatalogAt) void this.refreshCatalog();
    for (const wallet of this.wallets.values()) {
      if (wallet.connection.hasSubscription(wallet.address) && this.now() >= wallet.nextRecoveryAt)
        void this.recover(wallet);
    }
  }

  async refreshCatalog(): Promise<void> {
    if (this.stopped || this.catalogLoading) return;
    this.catalogLoading = true;
    try {
      const addresses = await this.options.loadActiveWallets();
      if (this.stopped) return;
      // The MVP catalog is small. Bound memory and subscription counts before applying any changes.
      if (addresses.length > 100) throw new Error("Catalog exceeds watcher capacity");
      const active = new Set(addresses.map((address) => solanaAddressSchema.parse(address)));
      for (const [address, wallet] of this.wallets) {
        if (active.has(address)) continue;
        this.wallets.delete(address);
        wallet.connection.remove(address);
      }
      for (const address of active) {
        if (this.wallets.has(address)) continue;
        const connection = this.connections.reduce((a, b) => (a.wallets.size <= b.wallets.size ? a : b));
        const wallet: Wallet = {
          address,
          connection,
          checkpoint: undefined,
          initialized: false,
          caughtUp: false,
          revision: 0,
          recovering: false,
          nextRecoveryAt: 0,
          error: null,
          completed: new Set(),
          pending: new Map(),
          undelivered: new Map(),
        };
        this.wallets.set(address, wallet);
        connection.add(address);
      }
      this.catalogHealthy = true;
    } catch {
      this.catalogHealthy = false;
    } finally {
      this.catalogLoading = false;
      this.nextCatalogAt = this.now() + 15_000;
    }
  }

  private get headSlot(): number {
    return Math.max(0, ...this.connections.map((connection) => connection.latestSlot));
  }
  private active(wallet: Wallet): boolean {
    return !this.stopped && this.wallets.get(wallet.address) === wallet;
  }
  private isStale(wallet: Wallet): boolean {
    return (
      this.stopped ||
      !this.catalogHealthy ||
      !wallet.caughtUp ||
      !wallet.connection.hasSubscription(wallet.address) ||
      wallet.connection.latestSlot === 0 ||
      this.headSlot - wallet.connection.latestSlot > this.staleSlots ||
      this.options.rpc.status.degraded
    );
  }
  private invalidate(wallet: Wallet): void {
    wallet.caughtUp = false;
    wallet.revision++;
  }

  private process(wallet: Wallet, signature: string, source: "provisional" | "backfill"): Promise<boolean> {
    if (!this.active(wallet)) return Promise.resolve(false);
    if (wallet.completed.has(signature)) return Promise.resolve(true);
    const pending = wallet.pending.get(signature);
    if (pending) return pending;
    if (wallet.pending.size >= 100 || (!wallet.undelivered.has(signature) && wallet.undelivered.size >= 100)) {
      this.invalidate(wallet);
      return Promise.resolve(false);
    }
    const previous = wallet.undelivered.get(signature);
    const observedAtMs = previous?.observedAtMs ?? this.now();
    const result = Promise.resolve()
      .then(() => {
        if (!this.active(wallet)) return null;
        return previous?.outcome ?? this.options.rpc.queueTransaction(wallet.address, signature, source);
      })
      .then(async (outcome) => {
        if (!outcome || !this.active(wallet)) return false;
        if (outcome.status === "not-ready" || outcome.status === "dropped") {
          this.invalidate(wallet);
          return false;
        }
        if (outcome.status === "buy" || outcome.status === "ignored") {
          const stale =
            previous?.stale === true ||
            this.isStale(wallet) ||
            (outcome.status === "buy" && this.headSlot - outcome.buy.slot > this.staleSlots);
          const event = { outcome, source: previous?.source ?? source, stale, observedAtMs };
          wallet.undelivered.set(signature, event);
          await this.options.onEvent(event);
          wallet.undelivered.delete(signature);
        }
        wallet.completed.add(signature);
        if (wallet.completed.size > 10_000) {
          const oldest = wallet.completed.values().next().value;
          if (oldest !== undefined) wallet.completed.delete(oldest);
        }
        return true;
      })
      .catch(() => {
        this.invalidate(wallet);
        wallet.error = "recovery-failed";
        return false;
      })
      .finally(() => wallet.pending.delete(signature));
    wallet.pending.set(signature, result);
    return result;
  }

  private async recover(wallet: Wallet): Promise<void> {
    if (!this.active(wallet) || wallet.recovering) return;
    wallet.recovering = true;
    const revision = wallet.revision;
    const generation = wallet.connection.generation;
    try {
      const entries: Awaited<ReturnType<WatcherRpc["getSignaturesForAddress"]>> = [];
      let before: string | undefined;
      let found = false;
      // Scan to the previous confirmed cursor, then process oldest first. Never advance it on live sightings.
      for (let page = 0; page < 100; page++) {
        const batch = await this.options.rpc.getSignaturesForAddress(wallet.address, {
          limit: 50,
          ...(before ? { before } : {}),
        });
        if (!this.active(wallet)) return;
        const index = batch.findIndex((entry) => entry.signature === wallet.checkpoint);
        entries.push(...(index >= 0 ? batch.slice(0, index) : batch));
        if (index >= 0 || !wallet.initialized || (batch.length < 50 && wallet.checkpoint === undefined)) {
          found = true;
          break;
        }
        if (batch.length < 50) break;
        const last = batch.at(-1)?.signature;
        if (!last || last === before) break;
        before = last;
      }
      if (!found) {
        this.invalidate(wallet);
        wallet.error = "history-gap";
        return;
      }
      const newest = entries[0]?.signature;
      for (const entry of entries.reverse()) {
        if (!this.active(wallet)) return;
        if (entry.err === null && !(await this.process(wallet, entry.signature, "backfill")))
          throw new Error("Recovery incomplete");
      }
      if (!this.active(wallet)) return;
      wallet.checkpoint = newest ?? wallet.checkpoint;
      wallet.initialized = true;
      wallet.error = null;
      wallet.caughtUp = wallet.revision === revision && wallet.connection.generation === generation;
    } catch {
      this.invalidate(wallet);
      wallet.error = "recovery-failed";
    } finally {
      wallet.recovering = false;
      wallet.nextRecoveryAt = this.now() + 30_000;
    }
  }
}
