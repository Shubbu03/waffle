import {
  type AuthStore,
  createLiveReadStore,
  type LiveDispatchStore,
  type LivePage,
  type LiveReadStore,
} from "@waffle/db";
import { type ApiErrorCode, type LiveServerEvent, liveClientMessageSchema } from "@waffle/shared";
import { hashSecret } from "./auth.ts";

export type LiveTransport = { send(frame: LiveServerEvent): boolean; close(code: number, reason: string): void };
type Client = {
  transport: LiveTransport;
  ip: string;
  openedAt: number;
  subscription?: { view: "all" | "following"; tokenHash?: string; cursor: string | null; ready: boolean };
  busy?: Promise<void>;
  deadline?: ReturnType<typeof setTimeout>;
};

/** Bounded best-effort sockets; Postgres cursors, never in-memory broadcasts, are the recovery source. */
export class LiveDelivery {
  private readonly clients = new Set<Client>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private running = false;
  private stopped = false;
  private failed = false;
  private lastPollAt: number | null = null;
  constructor(
    private readonly dependencies: {
      auth: AuthStore;
      reads: LiveReadStore;
      dispatch: LiveDispatchStore;
      now?: () => number;
    },
  ) {}
  private now() {
    return (this.dependencies.now ?? Date.now)();
  }
  get status() {
    return { connections: this.clients.size, degraded: this.failed, lastPollAt: this.lastPollAt };
  }

  connect(transport: LiveTransport, ip: string) {
    const time = this.now();
    for (const [key, attempt] of this.attempts) if (attempt.until <= time) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) ?? { count: 0, until: time + 60_000 };
    const activeForIp = [...this.clients].filter((client) => client.ip === ip).length;
    if (
      this.stopped ||
      this.clients.size >= 64 ||
      activeForIp >= 4 ||
      this.attempts.size >= 1000 ||
      ++attempt.count > 10
    ) {
      transport.close(1013, "Connection limit reached");
      return null;
    }
    this.attempts.set(ip, attempt);
    const client: Client = { transport, ip, openedAt: time };
    this.clients.add(client);
    const deadline = setTimeout(() => {
      if (!client.subscription) this.fail(client, "UNAUTHORIZED", "Subscribe or authenticate within five seconds");
    }, 5000);
    client.deadline = deadline;
    deadline.unref();
    if (this.running) this.schedule(0);
    return {
      receive: async (data: unknown) => {
        if (!this.clients.has(client)) return;
        // One subscription per socket bounds message rate and prevents overlapping auth/view changes.
        if (client.subscription || typeof data !== "string" || Buffer.byteLength(data) > 2048) {
          this.fail(client, "VALIDATION_ERROR", "Expected one bounded subscription frame");
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          this.fail(client, "VALIDATION_ERROR", "Invalid live frame");
          return;
        }
        const parsed = liveClientMessageSchema.safeParse(value);
        if (!parsed.success) {
          this.fail(client, "VALIDATION_ERROR", "Invalid live frame");
          return;
        }
        clearTimeout(deadline);
        const message = parsed.data;
        client.subscription =
          message.type === "auth"
            ? { view: "following", tokenHash: hashSecret(message.accessToken), cursor: message.cursor, ready: false }
            : { view: "all", cursor: message.cursor, ready: false };
        await this.sync(client).catch(() => undefined);
      },
      close: () => {
        clearTimeout(deadline);
        this.clients.delete(client);
      },
    };
  }
  private close(client: Client, code: number, reason: string) {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.deadline);
    client.transport.close(code, reason);
  }
  private send(client: Client, frame: LiveServerEvent) {
    if (!this.clients.has(client)) return false;
    try {
      if (client.transport.send(frame)) return true;
    } catch {
      /* The transport has disconnected; recover with the applied cursor. */
    }
    this.close(client, 1013, "Reconnect with your last applied cursor");
    return false;
  }
  private fail(client: Client, code: ApiErrorCode, message: string) {
    this.send(client, { v: 1, type: "error", error: { code, message } });
    this.close(client, 1008, message);
  }
  private apply(client: Client, page: LivePage) {
    const sub = client.subscription;
    if (!sub || !this.clients.has(client)) return;
    if (sub.cursor && sub.cursor !== "0" && (!page.oldest || BigInt(sub.cursor) < BigInt(page.oldest))) {
      if (page.oldest) this.send(client, { v: 1, type: "gap", view: sub.view, oldestAvailableEventId: page.oldest });
      else
        this.send(client, { v: 1, type: "error", error: { code: "CURSOR_EXPIRED", message: "Reload recent history" } });
      this.close(client, 1008, "Reload recent history");
      return;
    }
    if (sub.cursor && page.latest && BigInt(sub.cursor) > BigInt(page.latest)) {
      this.fail(client, "VALIDATION_ERROR", "Cursor is ahead of available history");
      return;
    }
    for (const event of page.events) {
      if (sub.cursor && BigInt(event.eventId) <= BigInt(sub.cursor)) continue;
      if (!this.send(client, { v: 1, type: "signal", view: sub.view, ...event })) return;
      sub.cursor = event.eventId;
    }
    if (!page.hasMore) {
      sub.cursor = page.latest ?? "0";
      if (!sub.ready) {
        if (!this.send(client, { v: 1, type: "ready", view: sub.view, latestEventId: page.latest })) return;
        sub.ready = true;
      }
    }
  }
  private sync(client: Client): Promise<void> {
    if (client.busy) return client.busy;
    const sub = client.subscription;
    if (!sub) return Promise.resolve();
    const work = async () => {
      try {
        if (sub.view === "following" && sub.tokenHash) {
          const valid = await this.dependencies.auth.withSession(sub.tokenHash, async (tx, session) => {
            const page = await createLiveReadStore(tx).page(sub.cursor, session.userId);
            // Hold the session lock through sending so logout cannot race this batch.
            this.apply(client, page);
            return true;
          });
          if (!valid) this.fail(client, "UNAUTHORIZED", "Session expired or revoked");
        } else this.apply(client, await this.dependencies.reads.page(sub.cursor));
      } catch {
        this.failed = true;
        this.send(client, {
          v: 1,
          type: "error",
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Live delivery unavailable; reconnect with your applied cursor",
          },
        });
        this.close(client, 1011, "Live delivery unavailable");
        throw new Error("Live delivery database operation failed");
      }
    };
    client.busy = work().finally(() => {
      delete client.busy;
    });
    return client.busy;
  }
  tick(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.stopped) return Promise.resolve();
    const poll = async () => {
      try {
        const pending = await this.dependencies.dispatch.pending();
        for (const client of this.clients) {
          if (!client.subscription && this.now() - client.openedAt >= 5000)
            this.fail(client, "UNAUTHORIZED", "Subscription timed out");
          else await this.sync(client);
        }
        await this.dependencies.dispatch.markDispatched(pending.map((event) => event.id));
        this.failed = false;
        this.lastPollAt = this.now();
      } catch {
        this.failed = true;
      }
    };
    this.polling = poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.running) this.schedule(this.clients.size ? 2000 : 30_000);
    }, delay);
    this.timer.unref();
  }
  start() {
    if (!this.running && !this.stopped) {
      this.running = true;
      this.schedule(0);
    }
  }
  async stop() {
    this.running = false;
    this.stopped = true;
    clearTimeout(this.timer);
    const work = [...this.clients].flatMap((client) => (client.busy ? [client.busy] : []));
    for (const client of this.clients) this.close(client, 1001, "Server shutting down");
    await Promise.allSettled([this.polling, ...work]);
  }
}
