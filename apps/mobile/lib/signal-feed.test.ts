import { afterEach, describe, expect, test } from 'bun:test'
import type { SignalPage } from '@waffle/shared'
import { deferred, signalFixture, summaryFixture } from '../test-support/signal-fixture'
import { ApiError } from './api-error'
import { type FeedCache, parseFeedCache } from './signal-cache'
import { type LiveSocket, SignalFeed } from './signal-feed'

class Socket implements LiveSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: unknown[] = []
  closed = false
  send(message: string) {
    this.sent.push(JSON.parse(message))
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}
const controllers: SignalFeed[] = []
afterEach(() => {
  for (const controller of controllers) controller.stop()
  controllers.length = 0
})
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 1000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected state not reached')
    await Bun.sleep(1)
  }
}
function setup(options: Partial<ConstructorParameters<typeof SignalFeed>[0]> = {}, initial: FeedCache | null = null) {
  let cache = initial
  const sockets: Socket[] = []
  const details: string[] = []
  const page: SignalPage = { view: 'all', direction: 'before', items: [], nextCursor: null, hasMore: false }
  const dependencies: ConstructorParameters<typeof SignalFeed>[0] = {
    view: 'all',
    subscriptionKey: null,
    networkEnabled: true,
    load: async () => cache,
    save: async (value) => {
      const parsed = parseFeedCache(JSON.stringify(value))
      if (!parsed) throw new Error('Invalid persisted cache')
      cache = parsed
    },
    list: async () => page,
    detail: async (id) => {
      details.push(id)
      return signalFixture('9007199254740993', Date.now(), id)
    },
    socket: () => {
      const socket = new Socket()
      sockets.push(socket)
      return socket
    },
    unauthorized: () => {},
    retryDelay: () => 1,
    ...options,
  }
  const controller = new SignalFeed(dependencies)
  controllers.push(controller)
  return {
    controller,
    dependencies,
    sockets,
    details,
    page,
    cache: () => cache,
    current: () => {
      const socket = sockets.at(-1)
      if (!socket) throw new Error('No socket')
      return socket
    },
  }
}
function event(detail = signalFixture()) {
  return { v: 1, type: 'signal', view: 'all', eventId: detail.eventId, signalId: detail.id, walletId: detail.walletId }
}
describe('signal REST/live/cache integration', () => {
  test('REST snapshots and ready watermarks never acknowledge events', async () => {
    const env = setup()
    env.page.items = [summaryFixture()]
    await env.controller.start()
    env.current().open()
    expect(env.current().sent[0]).toMatchObject({ type: 'subscribe', cursor: null })
    env.current().emit({ v: 1, type: 'ready', view: 'all', latestEventId: '9007199254740999' })
    await eventually(() => env.controller.getSnapshot().connection === 'live')
    expect(env.cache()?.appliedCursor).toBeNull()
  })
  test('fetches and applies ordered frames, persists exact cursors, and deduplicates replay', async () => {
    const env = setup()
    const first = signalFixture()
    const second = signalFixture('9007199254740994')
    env.dependencies.detail = async (id) => {
      env.details.push(id)
      return id === first.id ? first : second
    }
    await env.controller.start()
    env.current().open()
    env.current().emit(event(first))
    env.current().emit(event(first))
    env.current().emit(event(second))
    await eventually(() => env.cache()?.appliedCursor === second.eventId)
    expect(env.details).toEqual([first.id, second.id])
    expect(env.controller.getSnapshot().items.map((item) => item.id)).toEqual([second.id, first.id])
    expect(env.cache()?.items).toHaveLength(2)
    expect(parseFeedCache(JSON.stringify(env.cache()))).not.toBeNull()
  })
  test('failed detail stops the sequence and reconnects without skipping the failed event', async () => {
    const env = setup()
    const first = signalFixture()
    const second = signalFixture('9007199254740994')
    env.dependencies.detail = async (id) => {
      env.details.push(id)
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Down')
    }
    await env.controller.start()
    env.current().open()
    env.current().emit(event(first))
    env.current().emit(event(second))
    await eventually(() => env.sockets.length === 2)
    env.current().open()
    expect(env.current().sent[0]).toMatchObject({ cursor: null })
    expect(env.details).toEqual([first.id])
    expect(env.cache()?.appliedCursor).toBeNull()
  })
  test('a cache write failure cannot advance the reconnect cursor', async () => {
    const env = setup()
    const detail = signalFixture()
    env.dependencies.detail = async () => detail
    const save = env.dependencies.save
    env.dependencies.save = async (cache) => {
      if (cache.appliedCursor) throw new Error('Disk full')
      await save(cache)
    }
    await env.controller.start()
    env.current().open()
    env.current().emit(event(detail))
    await eventually(() => env.sockets.length === 2)
    env.current().open()
    expect(env.current().sent[0]).toMatchObject({ cursor: null })
    expect(env.cache()?.appliedCursor).toBeNull()
  })
  test('backgrounding prevents pending detail replies from modifying the feed', async () => {
    const env = setup()
    const detail = signalFixture()
    const pending = deferred<typeof detail>()
    let requested = false
    env.dependencies.detail = async () => {
      requested = true
      return pending.promise
    }
    await env.controller.start()
    env.current().open()
    env.current().emit(event(detail))
    await eventually(() => requested)
    env.controller.stop()
    pending.resolve(detail)
    await Bun.sleep(0)
    expect(env.controller.getSnapshot().items).toEqual([])
    expect(env.cache()?.appliedCursor).toBeNull()
    expect(env.current().closed).toBe(true)
  })
  test('restart reads the saved cursor and recovers only newer events', async () => {
    const old = summaryFixture('9007199254740992')
    const cached: FeedCache = {
      version: 1,
      items: [old],
      appliedCursor: old.eventId,
      nextCursor: null,
      hasMore: false,
      fetchedAt: Date.now(),
      subscriptionKey: null,
    }
    const env = setup({}, cached)
    await env.controller.start()
    env.current().open()
    expect(env.current().sent[0]).toMatchObject({ cursor: old.eventId })
    const detail = signalFixture()
    env.dependencies.detail = async () => detail
    env.current().emit(event(detail))
    await eventually(() => env.cache()?.appliedCursor === detail.eventId)
    expect(env.controller.getSnapshot().items).toHaveLength(2)
  })
  test('retention gaps reset the cursor and replace history with a bounded fresh page', async () => {
    const old = summaryFixture('1')
    const cached: FeedCache = {
      version: 1,
      items: [old],
      appliedCursor: '1',
      nextCursor: null,
      hasMore: false,
      fetchedAt: Date.now(),
      subscriptionKey: null,
    }
    const env = setup({}, cached)
    const current = summaryFixture('200')
    env.page.items = [current]
    await env.controller.start()
    env.current().open()
    env.current().emit({ v: 1, type: 'gap', view: 'all', oldestAvailableEventId: '100' })
    await eventually(() => env.sockets.length === 2)
    env.current().open()
    expect(env.current().sent[0]).toMatchObject({ cursor: null })
    expect(env.controller.getSnapshot()).toMatchObject({ historyGap: true, items: [current] })
  })
  test('Following authentication lives in the first frame and a membership change resets history', async () => {
    const old = summaryFixture('1')
    const cached: FeedCache = {
      version: 1,
      items: [old],
      appliedCursor: '1',
      nextCursor: null,
      hasMore: false,
      fetchedAt: Date.now(),
      subscriptionKey: '["old-wallet"]',
    }
    const env = setup({ view: 'following', token: 'a'.repeat(43), subscriptionKey: '["new-wallet"]' }, cached)
    env.page.view = 'following'
    await env.controller.start()
    env.current().open()
    expect(env.current().sent[0]).toEqual({
      v: 1,
      type: 'auth',
      view: 'following',
      accessToken: 'a'.repeat(43),
      cursor: null,
    })
    expect(env.controller.getSnapshot().items).toEqual([])
  })
  test('offline launch restores cache without making authenticated requests', async () => {
    const cached: FeedCache = {
      version: 1,
      items: [summaryFixture()],
      appliedCursor: null,
      nextCursor: null,
      hasMore: false,
      fetchedAt: Date.now(),
      subscriptionKey: '[]',
    }
    let reads = 0
    const env = setup(
      {
        view: 'following',
        networkEnabled: false,
        list: async () => {
          reads++
          throw new Error('offline')
        },
      },
      cached,
    )
    await env.controller.start()
    expect(env.controller.getSnapshot()).toMatchObject({ status: 'cached', items: cached.items, connection: 'paused' })
    expect(reads).toBe(0)
    expect(env.sockets).toHaveLength(0)
  })
  test('history pagination deduplicates overlap without touching live acknowledgement', async () => {
    const newer = summaryFixture('3')
    const older = summaryFixture('2')
    const cursors: (string | undefined)[] = []
    const env = setup({
      list: async (cursor) => {
        cursors.push(cursor)
        return {
          view: 'all',
          direction: 'before',
          items: cursor ? [newer, older] : [newer],
          nextCursor: cursor ? null : '3',
          hasMore: !cursor,
        }
      },
    })
    await env.controller.start()
    await env.controller.loadMore()
    expect(cursors).toEqual([undefined, '3'])
    expect(env.controller.getSnapshot().items.map((item) => item.eventId)).toEqual(['3', '2'])
    expect(env.cache()?.appliedCursor).toBeNull()
  })
  test('malformed and mismatched frames reconnect without applying data', async () => {
    for (const payload of [
      { v: 1, type: 'ready', view: 'following', latestEventId: null },
      { v: 7, type: 'signal' },
    ]) {
      const env = setup()
      await env.controller.start()
      env.current().open()
      env.current().emit(payload)
      await eventually(() => env.sockets.length === 2)
      expect(env.controller.getSnapshot().items).toEqual([])
      env.controller.stop()
    }
  })
  test('unauthorized Following closes its socket and signals session invalidation', async () => {
    let invalidated = false
    const env = setup({
      view: 'following',
      token: 'a'.repeat(43),
      unauthorized: () => {
        invalidated = true
      },
    })
    env.page.view = 'following'
    await env.controller.start()
    env.current().open()
    env.current().emit({ v: 1, type: 'error', error: { code: 'UNAUTHORIZED', message: 'Expired' } })
    await eventually(() => invalidated)
    expect(env.current().closed).toBe(true)
    expect(env.controller.getSnapshot().connection).toBe('paused')
  })
  test('pagination beyond the offline cache limit stays visible and caches a resumable boundary', async () => {
    const items = Array.from({ length: 250 }, (_, i) => summaryFixture(String(250 - i)))
    const env = setup({
      list: async (cursor) => {
        const offset = cursor ? items.findIndex((item) => item.eventId === cursor) + 1 : 0
        const page = items.slice(offset, offset + 50)
        const hasMore = offset + 50 < items.length
        return {
          view: 'all',
          direction: 'before',
          items: page,
          hasMore,
          nextCursor: hasMore ? (page.at(-1)?.eventId ?? null) : null,
        }
      },
    })
    await env.controller.start()
    for (let i = 0; i < 4; i++) await env.controller.loadMore()
    expect(env.controller.getSnapshot().items).toHaveLength(250)
    expect(env.cache()?.items).toHaveLength(200)
    expect(env.cache()?.nextCursor).toBe('51')
    expect(env.cache()?.hasMore).toBe(true)
  })
  test('oversized delivery is discarded before it can allocate an unbounded message queue', async () => {
    const env = setup()
    await env.controller.start()
    env.current().open()
    env.current().onmessage?.({ data: 'x'.repeat(8193) })
    await eventually(() => env.sockets.length === 2)
    expect(env.cache()?.appliedCursor).toBeNull()
    expect(env.details).toEqual([])
  })
  test('a failed history-gap cache reset still reloads and reconnects', async () => {
    const env = setup()
    await env.controller.start()
    env.current().open()
    env.dependencies.save = async () => {
      throw new Error('Disk full')
    }
    env.current().emit({ v: 1, type: 'gap', view: 'all', oldestAvailableEventId: '100' })
    await eventually(() => env.sockets.length === 2)
    env.current().open()
    expect(env.current().sent[0]).toMatchObject({ cursor: null })
    expect(env.controller.getSnapshot().historyGap).toBe(true)
  })
})
