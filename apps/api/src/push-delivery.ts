import type { PushDeliveryStore, PushSender } from "@waffle/db";

/** One bounded worker per API process; Postgres locks coordinate any overlapping processes. */
export class PushDelivery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private running = false;
  private stopped = false;
  private degraded = false;
  private lastPollAt: number | null = null;
  private accepted = 0;
  constructor(
    private readonly store: PushDeliveryStore,
    private readonly provider: { prepare(): Promise<PushSender> },
  ) {}
  get status() {
    return { degraded: this.degraded, lastPollAt: this.lastPollAt, accepted: this.accepted };
  }
  tick(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.stopped) return Promise.resolve();
    this.polling = (async () => {
      try {
        for (let count = 0; count < 10 && !this.stopped; count++) if (!(await this.store.expandOne())) break;
        // Authenticate outside job transactions, then recheck recipient state immediately before send.
        const send = await this.provider.prepare();
        let failures = false;
        for (let count = 0; count < 10 && !this.stopped; count++) {
          const result = await this.store.deliverOne(send);
          if (!result) break;
          if (result === "sent") this.accepted++;
          if (result === "retry" || result === "failed") failures = true;
          if (result === "retry") break;
        }
        this.degraded = failures;
        this.lastPollAt = Date.now();
      } catch {
        this.degraded = true;
      }
    })().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private schedule(delay: number) {
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.running) this.schedule(2000);
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
    await this.polling;
  }
}
