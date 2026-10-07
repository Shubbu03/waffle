import { expect, test } from 'bun:test'
import { signalFixture, summaryFixture } from '../test-support/signal-fixture'
import { type FeedCache, feedCacheKey, parseCachedDetail, parseFeedCache } from './signal-cache'

test('All and account-specific Following caches cannot share keys, including across APIs', () => {
  const keys = [
    feedCacheKey('https://api.example', 'all', null),
    feedCacheKey('https://api.example', 'following', 'one'),
    feedCacheKey('https://api.example', 'following', 'two'),
    feedCacheKey('https://other.example', 'following', 'one'),
  ]
  expect(new Set(keys).size).toBe(4)
  expect(() => feedCacheKey('https://api.example', 'following', null)).toThrow('owner')
})
test('cache validation preserves decimal cursors and rejects corrupt or unbounded history', () => {
  const cache: FeedCache = {
    version: 1,
    items: [summaryFixture()],
    appliedCursor: '9007199254740993',
    nextCursor: null,
    hasMore: false,
    fetchedAt: Date.now(),
    subscriptionKey: null,
  }
  expect(parseFeedCache(JSON.stringify(cache))).toEqual(cache)
  expect(parseFeedCache('broken')).toBeNull()
  expect(parseFeedCache(JSON.stringify({ ...cache, appliedCursor: Number('9007199254740993') }))).toBeNull()
  expect(parseFeedCache(JSON.stringify({ ...cache, items: Array(201).fill(cache.items[0]) }))).toBeNull()
  expect(parseFeedCache(JSON.stringify({ ...cache, items: [{ ...cache.items[0], score: 101 }] }))).toBeNull()
})
test('detail cache validates the complete score snapshot', () => {
  const cache = { signal: signalFixture(), fetchedAt: Date.now() }
  expect(parseCachedDetail(JSON.stringify(cache))).toEqual(cache)
  expect(parseCachedDetail(JSON.stringify({ ...cache, signal: { ...cache.signal, score: 100 } }))).toBeNull()
})

test('wallet history caches are isolated by wallet, view, account, and API', () => {
  const keys = [
    feedCacheKey('https://api.example', 'all', null),
    feedCacheKey('https://api.example', 'all', null, 'wallet-one'),
    feedCacheKey('https://api.example', 'all', null, 'wallet-two'),
    feedCacheKey('https://api.example', 'following', 'owner-one', 'wallet-one'),
    feedCacheKey('https://api.example', 'following', 'owner-two', 'wallet-one'),
    feedCacheKey('https://other.example', 'following', 'owner-one', 'wallet-one'),
  ]
  expect(new Set(keys).size).toBe(keys.length)
})
