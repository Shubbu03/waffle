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

export function parseWatcherRpcEnv(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse({
    HELIUS_RPC_URL: env.HELIUS_RPC_URL,
    RPC_REQUESTS_PER_SECOND: env.RPC_REQUESTS_PER_SECOND,
    RPC_PROGRAM_ACCOUNTS_PER_SECOND: env.RPC_PROGRAM_ACCOUNTS_PER_SECOND,
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]).filter(Boolean))].join(", ");
    throw new Error(`Invalid watcher RPC environment: ${fields}`);
  }
  return result.data;
}

const watcherEnvSchema = envSchema.extend({
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
  const result = watcherEnvSchema.safeParse(
    Object.fromEntries(Object.keys(watcherEnvSchema.shape).map((key) => [key, env[key]])),
  );
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]).filter(Boolean))].join(", ");
    throw new Error(`Invalid watcher environment: ${fields}`);
  }
  return result.data;
}
