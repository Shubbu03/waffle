import { DrizzleQueryError } from "drizzle-orm";

const connectionCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
]);

/** Recognize database transport failures without treating provider or SQL errors as outages. */
export function databaseConnectionErrorCode(error: unknown): string | null {
  if (!(error instanceof DrizzleQueryError)) return null;
  const cause = error.cause;
  if (!(cause instanceof Error) || !("code" in cause) || typeof cause.code !== "string") return null;
  return connectionCodes.has(cause.code) ? cause.code : null;
}
