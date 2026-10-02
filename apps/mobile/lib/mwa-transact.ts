/** Bounded wallet calls for issue #21 (no native imports — bun-testable).
 * MWA promises can hang forever (lost intent, killed wallet, session collision).
 * Every call here races a timeout so a hang becomes an actionable error. */

export async function withTransactTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  console.log(`[auth] transact: ${label} start (timeout ${ms}ms)`)
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — wallet did not answer`)), ms)
      }),
    ])
    console.log(`[auth] transact: ${label} answered in ${Date.now() - started}ms`)
    return result
  } catch (error) {
    console.log(`[auth] transact: ${label} failed (${error instanceof Error ? error.message : 'unknown'})`)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const WALLET_SIGN_TIMEOUT_MS = 60_000
