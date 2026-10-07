import { z } from "zod";

const portSchema = z.string().regex(/^\d+$/).default("3000").transform(Number).pipe(z.number().int().min(1).max(65535));

const databaseUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    // URL accepts malformed escapes that postgres.js cannot decode.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.username.length > 0 &&
      url.password.length > 0 &&
      url.searchParams.getAll("sslmode").length === 1 &&
      ["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")
    );
  } catch {
    return false;
  }
}, "Expected a PostgreSQL URL with credentials and sslmode=require or verify-full");

const envSchema = z.strictObject({
  DATABASE_URL: databaseUrlSchema,
  DELIVERY_DATABASE_URL: databaseUrlSchema.optional(),
  AUTH_URI: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.host.length <= 253;
    } catch {
      return false;
    }
  }, "Expected a public HTTPS sign-in URI without credentials or fragment"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: portSchema,
  // Optional: enables pasted-wallet validation (recent PumpSwap activity + volume guard).
  // Server-side only; never expose to the mobile app. Without it, tracking skips validation.
  HELIUS_RPC_URL: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "Expected an HTTPS RPC URL")
    .optional(),
  RPC_REQUESTS_PER_SECOND: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default("10")
    .transform(Number)
    .pipe(z.number().int().min(1).max(10)),
});

export class ApiConfigurationError extends Error {
  constructor(readonly fields: string[]) {
    super(`Invalid API environment: ${fields.join(", ")}`);
  }
}

export function parseApiEnv(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse({
    DATABASE_URL: env.DATABASE_URL,
    DELIVERY_DATABASE_URL: env.DELIVERY_DATABASE_URL,
    AUTH_URI: env.AUTH_URI,
    API_HOST: env.API_HOST,
    API_PORT: env.API_PORT,
    HELIUS_RPC_URL: env.HELIUS_RPC_URL,
    RPC_REQUESTS_PER_SECOND: env.RPC_REQUESTS_PER_SECOND,
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new ApiConfigurationError(fields);
  }
  return result.data;
}
