import { scorePolicyV1, solanaAddressSchema } from "@waffle/shared";
import { z } from "zod";
import { type Evidence, EvidenceCache, EvidenceUnavailable } from "./evidence-cache.ts";

export const pythFeedMapSchema = z
  .record(solanaAddressSchema, z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/))
  .refine((feeds) => Object.keys(feeds).length <= 100);
const updateSchema = z.object({
  parsed: z
    .array(
      z.object({
        id: z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/),
        price: z.object({
          price: z.string().regex(/^\d{1,30}$/),
          conf: z.string().regex(/^\d{1,30}$/),
          expo: z.number().int().min(-18).max(18),
          publish_time: z.number().int().nonnegative().safe(),
        }),
      }),
    )
    .max(1),
});
export type PythPrice = { mintAddress: string; feedId: string; priceUsd: number };
const normalized = (id: string) => id.replace(/^0x/, "").toLowerCase();

export class PythPrices {
  private readonly cache: EvidenceCache<PythPrice>;
  private readonly feeds: Record<string, string>;
  private nextRequestAt = 0;
  constructor(
    private readonly options: {
      apiKey?: string;
      feeds: Record<string, string>;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.feeds = pythFeedMapSchema.parse(options.feeds);
    this.cache = new EvidenceCache(this.now);
  }
  private now = (): number => (this.options.now ?? Date.now)();

  get(mint: string): Promise<Evidence<PythPrice>> {
    const feed = this.feeds[mint];
    if (!feed) return Promise.resolve({ status: "unknown", reason: "no-same-asset-feed" });
    if (!this.options.apiKey) return Promise.resolve({ status: "unknown", reason: "pyth-not-configured" });
    return this.cache.get(mint, async () => {
      if (this.now() < this.nextRequestAt) throw new EvidenceUnavailable("oracle-rate-limited");
      this.nextRequestAt = this.now() + 1000;
      const url = new URL("https://pyth.dourolabs.app/hermes/v2/updates/price/latest");
      url.searchParams.set("ids[]", normalized(feed));
      url.searchParams.set("parsed", "true");
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new EvidenceUnavailable("oracle-unavailable");
      // Stop reading at the cap; never buffer an unbounded upstream payload.
      if (!response.body) throw new EvidenceUnavailable("invalid-oracle-response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 100_000) {
            await reader.cancel();
            throw new EvidenceUnavailable("invalid-oracle-response");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const parsed = updateSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const update = parsed.success ? parsed.data.parsed[0] : undefined;
      if (!update || normalized(update.id) !== normalized(feed)) throw new EvidenceUnavailable("oracle-feed-mismatch");
      const price = Number(update.price.price);
      const priceUsd = price * 10 ** update.price.expo;
      if (!Number.isFinite(priceUsd) || priceUsd <= 0 || Number(update.price.conf) / price > 0.01)
        throw new EvidenceUnavailable("oracle-price-uncertain");
      const fetchedAtMs = update.price.publish_time * 1000;
      return {
        value: { mintAddress: mint, feedId: normalized(feed), priceUsd },
        fetchedAtMs,
        expiresAtMs: fetchedAtMs + scorePolicyV1.freshness.oracleMs,
      };
    });
  }
}
