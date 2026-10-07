import { describe, expect, test } from 'bun:test'
import { pushFixture } from '../test-support/push-fixture'
import { deferred } from '../test-support/signal-fixture'
import { receiveSignalPush, type SeenPush } from './push-receiver'
import { PushRegistrationController } from './push-registration'

function setup() {
  let now = Date.now()
  const { signal, data } = pushFixture(now)
  let seen: SeenPush[] = []
  let reads = 0
  const shown: string[] = []
  const dependencies = {
    now: () => now,
    loadSeen: async () => seen,
    saveSeen: async (_owner: string, next: SeenPush[]) => {
      seen = next
    },
    signal: async () => {
      ++reads
      return signal
    },
  }
  const receive = (canDeliver = async () => true) =>
    receiveSignalPush(dependencies, data, 'owner', canDeliver, async (detail) => {
      shown.push(detail.id)
    })
  return {
    dependencies,
    signal,
    data,
    shown,
    receive,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('push receipt', () => {
  test('fresh backend data reloads detail, displays once, and deduplicates after receiver restart', async () => {
    const env = setup()
    expect(await env.receive()).toBe(true)
    expect(await env.receive()).toBe(false)
    expect(env.reads()).toBe(1)
    expect(env.shown).toEqual([env.signal.id])
  })
  test('denied permission and expired payloads do not fetch or display', async () => {
    const env = setup()
    expect(await env.receive(async () => false)).toBe(false)
    env.advance(90_000)
    expect(await env.receive()).toBe(false)
    expect(env.reads()).toBe(0)
  })
  test('expiry, revocation, changed eligibility and mismatched detail after the request suppress display', async () => {
    for (const failure of ['expired', 'denied', 'suppressed', 'mismatched', 'stale', 'unknown', 'degraded'] as const) {
      const env = setup()
      let granted = true
      env.dependencies.signal = async () => {
        if (failure === 'expired') env.advance(90_000)
        if (failure === 'denied') granted = false
        if (failure === 'suppressed') env.signal.status = 'suppressed'
        if (failure === 'mismatched') env.signal.walletAddress = '1'.repeat(32)
        if (failure === 'stale') env.signal.observedAt = '2000-01-01T00:00:00Z'
        if (failure === 'unknown') env.signal.dataStatus = 'unknown'
        if (failure === 'degraded' && env.signal.snapshot.assessment) env.signal.snapshot.assessment.streamStale = true
        return env.signal
      }
      expect(await env.receive(async () => granted)).toBe(false)
      expect(env.shown).toEqual([])
    }
  })
  test('failed detail loads or displays never consume the signal ID', async () => {
    const env = setup()
    const detail = env.dependencies.signal
    env.dependencies.signal = async () => {
      throw new Error('offline')
    }
    await expect(env.receive()).rejects.toThrow('offline')
    env.dependencies.signal = detail
    await expect(
      receiveSignalPush(
        env.dependencies,
        env.data,
        'owner',
        async () => true,
        async () => {
          throw new Error('native failure')
        },
      ),
    ).rejects.toThrow('native failure')
    expect(await env.receive()).toBe(true)
  })
  test('simultaneous foreground/background copies share the device queue and display once', async () => {
    const env = setup()
    const pending = deferred<void>()
    env.dependencies.signal = async () => {
      await pending.promise
      return env.signal
    }
    const queue = new PushRegistrationController({
      loadEnabled: async () => true,
      saveEnabled: async () => {},
      apiUrl: '',
      load: async () => null,
      save: async () => {},
      clear: async () => {},
      permission: async () => 'granted',
      getToken: async () => '',
      rotate: async () => {},
      register: async () => ({ id: '' }),
      remove: async () => {},
    })
    const first = queue.run(() => env.receive())
    const second = queue.run(() => env.receive())
    pending.resolve()
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(env.shown).toHaveLength(1)
  })
})

test('a push expiring during the final native permission check is never displayed', async () => {
  const env = setup()
  let checks = 0
  expect(
    await env.receive(async () => {
      if (++checks === 2) env.advance(90_000)
      return true
    }),
  ).toBe(false)
  expect(env.shown).toEqual([])
})
