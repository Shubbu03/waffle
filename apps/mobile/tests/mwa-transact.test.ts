/** Transact-timeout unit tests for issue #21 (pure logic, no device needed). */
import { describe, expect, test } from 'bun:test'
import { withTransactTimeout } from '../lib/mwa-transact'

describe('withTransactTimeout', () => {
  test('fast path resolves with value', async () => {
    await expect(withTransactTimeout('fast', 1000, async () => 42)).resolves.toBe(42)
  })

  test('hang rejects with timeout error', async () => {
    const error = await withTransactTimeout('hang', 20, () => new Promise<number>(() => {})).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('timed out')
  })

  test('rejections pass through untouched', async () => {
    const error = await withTransactTimeout('reject', 1000, async () => {
      throw new Error('wallet said no')
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('wallet said no')
  })
})
