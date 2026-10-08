export type Evidence<T> =
  | { status: "fresh" | "stale"; value: T; fetchedAtMs: number; expiresAtMs: number }
  | { status: "unknown"; reason: string };
export type Observation<T> = { value: T; fetchedAtMs: number; expiresAtMs: number };
export class EvidenceUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function freshness<T>(evidence: Evidence<T>, now: number): Evidence<T> {
  if (evidence.status === "unknown") return evidence;
  return { ...evidence, status: evidence.fetchedAtMs <= now && now < evidence.expiresAtMs ? "fresh" : "stale" };
}

/** Bounded per-source cache; preserves timestamps on failed refresh and shares concurrent requests. */
export class EvidenceCache<T> {
  private readonly entries = new Map<string, { evidence: Evidence<T>; retryAt: number }>();
  private readonly pending = new Map<string, Promise<Evidence<T>>>();
  constructor(
    private readonly now: () => number,
    private readonly capacity = 256,
  ) {}

  async get(key: string, load: () => Promise<Observation<T>>): Promise<Evidence<T>> {
    const cached = this.entries.get(key);
    if (cached && this.now() < cached.retryAt) return structuredClone(freshness(cached.evidence, this.now()));
    const existing = this.pending.get(key);
    if (existing) return structuredClone(freshness(await existing, this.now()));
    if (this.pending.size >= this.capacity) return { status: "unknown", reason: "evidence-capacity" };
    const promise = Promise.resolve()
      .then(load)
      .then((observation): Evidence<T> => {
        if (
          !Number.isSafeInteger(observation.fetchedAtMs) ||
          observation.fetchedAtMs < 0 ||
          observation.fetchedAtMs > this.now() ||
          !Number.isSafeInteger(observation.expiresAtMs) ||
          observation.expiresAtMs <= observation.fetchedAtMs
        )
          throw new EvidenceUnavailable("invalid-timestamp");
        return freshness({ status: "fresh", ...observation }, this.now());
      })
      .catch((error: unknown): Evidence<T> => {
        if (cached && cached.evidence.status !== "unknown") return freshness(cached.evidence, this.now());
        return {
          status: "unknown",
          reason: error instanceof EvidenceUnavailable ? error.reason : "upstream-unavailable",
        };
      })
      .then((evidence) => {
        this.entries.delete(key);
        this.entries.set(key, {
          evidence,
          retryAt: evidence.status === "fresh" ? evidence.expiresAtMs : this.now() + 2000,
        });
        while (this.entries.size > this.capacity) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
        return evidence;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return structuredClone(await promise);
  }
}
