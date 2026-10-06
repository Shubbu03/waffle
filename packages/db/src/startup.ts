import { databaseConnectionErrorCode } from "./connection-error.ts";

/** Verify restricted database logins before starting service traffic or ingestion. */
export async function waitForDatabase(
  verify: () => Promise<void>,
  options: {
    onRetry: (status: { code: string; attempt: number; retryInMs: number }) => void;
    wait?: (milliseconds: number) => Promise<unknown>;
  },
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await verify();
      return;
    } catch (error) {
      const code = databaseConnectionErrorCode(error);
      if (!code) throw error;
      const retryInMs = Math.min(30_000, 2000 * 2 ** Math.min(attempt++, 4));
      options.onRetry({ code, attempt, retryInMs });
      await (options.wait ?? Bun.sleep)(retryInMs);
    }
  }
}
