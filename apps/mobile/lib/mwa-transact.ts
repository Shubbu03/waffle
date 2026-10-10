/** Bounded wallet calls.
 * MWA promises can hang forever (lost intent, killed wallet, session collision).
 * Every call here races a timeout so a hang becomes an actionable error. */

export async function withTransactTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — wallet did not answer`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const WALLET_SIGN_TIMEOUT_MS = 60_000
