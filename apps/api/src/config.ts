import { z } from "zod";

const portSchema = z.string().regex(/^\d+$/).default("3000").transform(Number).pipe(z.number().int().min(1).max(65535));

const databaseUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.username.length > 0 && url.password.length > 0 &&
      url.searchParams.getAll("sslmode").length === 1 &&
      ["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
  } catch {
    return false;
  }
}, "Expected a PostgreSQL URL with credentials and sslmode=require or verify-full");

const envSchema = z.strictObject({
  DATABASE_URL: databaseUrlSchema,
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: portSchema,
});

export function parseApiEnv(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse({
    DATABASE_URL: env.DATABASE_URL,
    API_HOST: env.API_HOST,
    API_PORT: env.API_PORT,
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]).filter(Boolean))].join(", ");
    throw new Error(`Invalid API environment: ${fields}`);
  }
  return result.data;
}
