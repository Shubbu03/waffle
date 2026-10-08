import { pythFeedMapSchema } from "@waffle/market-data/pyth";
import { scorePolicyV1 } from "@waffle/shared";
import { z } from "zod";

const rate = (maximum: number, fallback: string) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(1).max(maximum));

const envSchema = z.strictObject({
  HELIUS_RPC_URL: z.url().refine((value) => new URL(value).protocol === "https:", "Expected an HTTPS RPC URL"),
  RPC_REQUESTS_PER_SECOND: rate(10, "10"),
  RPC_PROGRAM_ACCOUNTS_PER_SECOND: rate(5, "5"),
});

export class WatcherConfigurationError extends Error {
  constructor(
    readonly fields: string[],
    scope = "watcher",
  ) {
    super(`Invalid ${scope} environment: ${fields.join(", ")}`);
  }
}

export function parseWatcherRpcEnv(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse({
    HELIUS_RPC_URL:
      env.SOLANA_NETWORK === "devnet"
        ? (env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com")
        : env.HELIUS_RPC_URL,
    RPC_REQUESTS_PER_SECOND: env.RPC_REQUESTS_PER_SECOND,
    RPC_PROGRAM_ACCOUNTS_PER_SECOND: env.RPC_PROGRAM_ACCOUNTS_PER_SECOND,
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new WatcherConfigurationError(fields, "watcher RPC");
  }
  return result.data;
}

const watcherEnvSchema = envSchema.extend({
  SOLANA_NETWORK: z.enum(["mainnet", "devnet", "testnet"]).default("mainnet"),
  JUPITER_API_KEY: z.string().trim().max(512).default(""),
  WATCHER_COPY_SIZE_LAMPORTS: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .default("50000000")
    .transform(BigInt)
    .refine((value) => value >= scorePolicyV1.sizeLamports.quoteProbe && value <= scorePolicyV1.sizeLamports.paperMax),
  PYTH_API_KEY: z.string().trim().max(512).default(""),
  PYTH_PRICE_FEEDS_JSON: z
    .string()
    .max(16_384)
    .default("{}")
    .transform((value, context) => {
      try {
        const parsed = pythFeedMapSchema.safeParse(JSON.parse(value));
        if (parsed.success) return parsed.data;
      } catch {
        /* Report only the field name; never echo configuration values. */
      }
      context.addIssue({ code: "custom", message: "Expected exact-mint to Pyth USD feed mapping" });
      return z.NEVER;
    }),
  DATABASE_URL: z.url().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
  HELIUS_WSS_URL: z.url().refine((value) => new URL(value).protocol === "wss:"),
  WATCHER_CONNECTIONS: z
    .enum(["2", "3"])
    .default("2")
    .transform((value) => (value === "2" ? (2 as const) : (3 as const))),
  WATCHER_STALE_SLOTS: rate(10_000, "150"),
  WATCHER_STATUS_PORT: rate(65_535, "3002"),
});

export function parseWatcherEnv(env: Record<string, string | undefined>) {
  const selected = {
    ...env,
    HELIUS_RPC_URL:
      env.SOLANA_NETWORK === "devnet"
        ? (env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com")
        : env.HELIUS_RPC_URL,
    HELIUS_WSS_URL:
      env.SOLANA_NETWORK === "devnet"
        ? (env.SOLANA_DEVNET_WSS_URL ?? "wss://api.devnet.solana.com")
        : env.HELIUS_WSS_URL,
  };
  const result = watcherEnvSchema.safeParse(
    Object.fromEntries(Object.keys(watcherEnvSchema.shape).map((key) => [key, selected[key as keyof typeof selected]])),
  );
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new WatcherConfigurationError(fields);
  }
  if (result.data.SOLANA_NETWORK === "mainnet" && !result.data.JUPITER_API_KEY)
    throw new WatcherConfigurationError(["JUPITER_API_KEY"]);
  if (result.data.SOLANA_NETWORK === "testnet")
    throw new WatcherConfigurationError(["SOLANA_NETWORK (PumpSwap is not deployed on Testnet; use Devnet)"]);
  return result.data;
}
