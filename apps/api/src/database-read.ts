import { databaseConnectionErrorCode } from "@waffle/db";

/** A DNS failure happens before PostgreSQL receives the read. Retry it once after a short pause. */
export async function readWithDnsRetry<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const code = databaseConnectionErrorCode(error);
    if (code !== "ENOTFOUND" && code !== "EAI_AGAIN") throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (signal.aborted) throw error;
    return read();
  }
}
