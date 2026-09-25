export type RpcMethod = "getTransaction" | "getSignaturesForAddress" | "getAccountInfo" | "getProgramAccounts";

export type RpcPriority = "provisional" | "evidence" | "backfill";

export type RpcSchedulerOptions = {
  requestsPerSecond?: number;
  programAccountsPerSecond?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxQueued?: number;
  maxProvisionalQueued?: number;
};

type Job = {
  method: RpcMethod;
  priority: RpcPriority;
  sequence: number;
  readyAt: number;
  attempt: number;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const priorityOrder: Record<RpcPriority, number> = {
  provisional: 0,
  evidence: 1,
  backfill: 2,
};

export class RpcHttpError extends Error {
  constructor(readonly status: number) {
    super(`RPC HTTP status ${status}`);
  }
}

export class RpcRemoteError extends Error {
  constructor(readonly code: number) {
    super(`RPC error code ${code}`);
  }
}

export class RpcTimeoutError extends Error {
  constructor() {
    super("RPC request timed out");
  }
}

export class RpcQueueFullError extends Error {
  constructor() {
    super("RPC queue is full");
  }
}

export class RpcProvisionalDroppedError extends Error {
  constructor() {
    super("Provisional RPC event dropped after queue overload");
  }
}

export class RpcNotReadyError extends Error {
  constructor() {
    super("Transaction is not confirmed yet");
  }
}

function retryable(error: unknown): boolean {
  return (
    error instanceof RpcTimeoutError ||
    error instanceof RpcNotReadyError ||
    (error instanceof RpcHttpError && (error.status === 429 || error.status >= 500)) ||
    (error instanceof RpcRemoteError && error.code === -32005) ||
    error instanceof TypeError
  );
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** One scheduler per RPC endpoint. Every attempt, including a retry, consumes a slot. */
export class RpcScheduler {
  private readonly requestsPerSecond: number;
  private readonly programAccountsPerSecond: number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxQueued: number;
  private readonly maxProvisionalQueued: number;
  private readonly cancelActive = new Set<() => void>();
  private pending: Job[] = [];
  private active = 0;
  private sequence = 0;
  private dispatchCount = 0;
  private nextRequestAt = 0;
  private nextProgramAccountsAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private degraded = false;
  private droppedProvisional = 0;

  constructor(options: RpcSchedulerOptions = {}) {
    this.requestsPerSecond = boundedInteger(options.requestsPerSecond ?? 10, 1, 10, "requestsPerSecond");
    this.programAccountsPerSecond = boundedInteger(
      options.programAccountsPerSecond ?? 5,
      1,
      5,
      "programAccountsPerSecond",
    );
    this.maxConcurrent = boundedInteger(options.maxConcurrent ?? 4, 1, 10, "maxConcurrent");
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 4000, 1, 30000, "timeoutMs");
    this.retryDelayMs = boundedInteger(options.retryDelayMs ?? 250, 0, 30000, "retryDelayMs");
    this.maxQueued = boundedInteger(options.maxQueued ?? 500, 1, 10000, "maxQueued");
    this.maxProvisionalQueued = boundedInteger(options.maxProvisionalQueued ?? 50, 1, 50, "maxProvisionalQueued");
  }

  get status() {
    return {
      degraded: this.degraded,
      queued: this.pending.length,
      provisionalQueued: this.pending.filter((job) => job.priority === "provisional").length,
      inFlight: this.active,
      droppedProvisional: this.droppedProvisional,
    };
  }

  submit<T>(
    method: RpcMethod,
    priority: RpcPriority,
    run: (signal: AbortSignal) => Promise<T>,
  ): { accepted: true; result: Promise<T> } | { accepted: false } {
    if (this.closed) throw new Error("RPC scheduler is closed");
    if (priority === "provisional" && this.status.provisionalQueued >= this.maxProvisionalQueued) {
      this.degraded = true;
      this.droppedProvisional++;
      return { accepted: false };
    }
    if (this.pending.length >= this.maxQueued) {
      if (priority === "provisional") {
        this.degraded = true;
        this.droppedProvisional++;
        return { accepted: false };
      }
      throw new RpcQueueFullError();
    }

    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({
        method,
        priority,
        sequence: this.sequence++,
        readyAt: 0,
        attempt: 0,
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.pump();
    return { accepted: true, result };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const job of this.pending.splice(0)) job.reject(new Error("RPC scheduler closed"));
    for (const cancel of [...this.cancelActive]) cancel();
  }

  private pump(): void {
    if (this.closed || this.active >= this.maxConcurrent || this.pending.length === 0) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;

    const now = performance.now();
    let selected = -1;
    let earliest = Infinity;
    const eligible: number[] = [];
    for (const [index, job] of this.pending.entries()) {
      const at = Math.max(
        job.readyAt,
        this.nextRequestAt,
        job.method === "getProgramAccounts" ? this.nextProgramAccountsAt : 0,
      );
      earliest = Math.min(earliest, at);
      if (at <= now) eligible.push(index);
    }
    const fairTurn = this.dispatchCount % 5 === 4;
    const candidates = fairTurn ? eligible.filter((index) => this.pending[index]?.priority !== "provisional") : [];
    for (const index of candidates.length > 0 ? candidates : eligible) {
      const job = this.pending[index];
      if (job === undefined) continue;
      const current = this.pending[selected];
      if (
        current === undefined ||
        (candidates.length === 0 && priorityOrder[job.priority] < priorityOrder[current.priority]) ||
        ((candidates.length > 0 || priorityOrder[job.priority] === priorityOrder[current.priority]) &&
          job.sequence < current.sequence)
      ) {
        selected = index;
      }
    }
    if (selected < 0) {
      this.timer = setTimeout(() => this.pump(), Math.max(0, earliest - now));
      return;
    }

    const [job] = this.pending.splice(selected, 1);
    if (job === undefined) return;
    this.active++;
    this.dispatchCount++;
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + 1000 / this.requestsPerSecond;
    if (job.method === "getProgramAccounts") {
      this.nextProgramAccountsAt = Math.max(now, this.nextProgramAccountsAt) + 1000 / this.programAccountsPerSecond;
    }
    this.runJob(job);
    if (this.degraded && this.status.provisionalQueued === 0) this.degraded = false;
    this.pump();
  }

  private async runJob(job: Job): Promise<void> {
    try {
      job.resolve(await this.withTimeout(job.run));
    } catch (error) {
      if (!this.closed && job.attempt < 1 && retryable(error)) {
        if (job.priority === "provisional" && this.status.provisionalQueued >= this.maxProvisionalQueued) {
          this.degraded = true;
          this.droppedProvisional++;
          job.reject(new RpcProvisionalDroppedError());
        } else if (this.pending.length >= this.maxQueued) {
          if (job.priority === "provisional") {
            this.degraded = true;
            this.droppedProvisional++;
            job.reject(new RpcProvisionalDroppedError());
          } else {
            job.reject(new RpcQueueFullError());
          }
        } else {
          job.attempt++;
          job.readyAt = performance.now() + this.retryDelayMs;
          this.pending.push(job);
        }
      } else {
        job.reject(error);
      }
    } finally {
      this.active--;
      this.pump();
    }
  }

  private withTimeout(run: Job["run"]): Promise<unknown> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: (value: unknown) => void, value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelActive.delete(cancel);
        callback(value);
      };
      const cancel = () => {
        finish(reject, new Error("RPC scheduler closed"));
        controller.abort();
      };
      const timer = setTimeout(() => {
        finish(reject, new RpcTimeoutError());
        controller.abort();
      }, this.timeoutMs);
      this.cancelActive.add(cancel);
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw new Error("RPC scheduler closed");
          return run(controller.signal);
        })
        .then(
          (value) => finish(resolve, value),
          (error: unknown) => finish(reject, error),
        );
    });
  }
}
