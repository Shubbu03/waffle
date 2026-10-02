import { expect, test } from 'bun:test'
import type { PaperPositionWithFill, PaperQuote } from '@waffle/shared'
import { PAPER_TEST_SIGNAL, paperPositionFixture, paperQuoteFixture } from '../test-support/paper-fixture'
import { deferred, signalFixture } from '../test-support/signal-fixture'
import { ApiError } from './api-error'
import {
  formatRaw,
  formatSol,
  formatTokens,
  PaperTradeController,
  type PendingPaperFill,
  paperReviewBlock,
  parsePaperSize,
} from './paper-state'

const start = Date.parse('2026-10-02T10:00:00Z')
function harness() {
  let now = start
  let saved: PendingPaperFill | null = null
  let creates = 0
  let prepares = 0
  let lookupResult: PaperPositionWithFill | null = null
  let create = async (pending: PendingPaperFill) =>
    paperPositionFixture({ ...paperQuoteFixture(now, pending.sizeLamports), id: pending.quoteId }, now)
  let prepare = async (size: string) => paperQuoteFixture(now, size)
  let save = async (pending: PendingPaperFill) => {
    saved = pending
  }
  const controller = new PaperTradeController(PAPER_TEST_SIGNAL, {
    now: () => now,
    load: async () => saved,
    save: (pending) => save(pending),
    clear: async () => {
      saved = null
    },
    prepare: (size) => {
      prepares++
      return prepare(size)
    },
    create: (pending) => {
      creates++
      return create(pending)
    },
    lookup: async () => lookupResult,
  })
  return {
    controller,
    get creates() {
      return creates
    },
    get prepares() {
      return prepares
    },
    get saved() {
      return saved
    },
    set saved(value: PendingPaperFill | null) {
      saved = value
    },
    set time(value: number) {
      now = value
    },
    set create(value: typeof create) {
      create = value
    },
    set prepare(value: typeof prepare) {
      prepare = value
    },
    set save(value: typeof save) {
      save = value
    },
    set lookup(value: PaperPositionWithFill | null) {
      lookupResult = value
    },
  }
}
test('sizes and quantities preserve integer precision, boundaries, and verified decimals', () => {
  expect(parsePaperSize('0.000000001')).toBe('1')
  expect(parsePaperSize('0.100000000')).toBe('100000000')
  for (const bad of ['0', '-0.1', '0.100000001', '0.0000000001', '1e-2', 'NaN', ' 0.1', '1', '.1', '0,1'])
    expect(parsePaperSize(bad)).toBeNull()
  expect(formatRaw('9007199254740993123', 6)).toBe('9007199254740.993123')
  expect(formatTokens('123', undefined)).toContain('decimals unknown')
  expect(formatSol('-100000001')).toBe('-0.100000001 SOL')
})
test('preparing a new quote does not renew old pool evidence', () => {
  const signal = signalFixture(undefined, start)
  expect(paperReviewBlock(signal, false, start + 11_000)).toBeNull()
  expect(paperReviewBlock(signal, false, start + 16_000)).toContain('refreshing')
  expect(paperReviewBlock(signal, true, start)).toContain('Reconnect')
})
test('size changes invalidate a quote and an expired quote cannot submit', async () => {
  const h = harness()
  await h.controller.restore()
  await h.controller.prepare()
  h.controller.setSize('0.05')
  expect(h.controller.getSnapshot().quote).toBeNull()
  await h.controller.confirm()
  expect(h.creates).toBe(0)
  await h.controller.prepare()
  h.time = start + 10_000
  await h.controller.confirm()
  expect(h.creates).toBe(0)
  expect(h.controller.getSnapshot().error).toContain('expired')
})
test('late quote replies after background or account switch cannot enable confirmation', async () => {
  const h = harness()
  const request = deferred<PaperQuote>()
  h.prepare = () => request.promise
  await h.controller.restore()
  const prepare = h.controller.prepare()
  h.controller.invalidate()
  request.resolve(paperQuoteFixture(start))
  await prepare
  expect(h.controller.getSnapshot().quote).toBeNull()
  expect(h.controller.getSnapshot().busy).toBe(false)
})
test('mismatched quote sizes and expired provider replies are rejected', async () => {
  const h = harness()
  await h.controller.restore()
  h.prepare = async () => paperQuoteFixture(start, '1')
  await h.controller.prepare()
  expect(h.controller.getSnapshot().quote).toBeNull()
  h.prepare = async () => paperQuoteFixture(start)
  h.time = start + 10000
  await h.controller.prepare()
  expect(h.controller.getSnapshot().quote).toBeNull()
})
test('confirmation saves recovery state before one submission and ignores repeated taps', async () => {
  const h = harness()
  const response = deferred<PaperPositionWithFill>()
  h.create = async (pending) => {
    expect(h.saved?.quoteId).toBe(pending.quoteId)
    return response.promise
  }
  await h.controller.restore()
  await h.controller.prepare()
  const q = h.controller.getSnapshot().quote
  if (!q) throw new Error('Expected quote')
  const first = h.controller.confirm()
  await Promise.resolve()
  await h.controller.confirm()
  expect(h.creates).toBe(1)
  response.resolve(paperPositionFixture(q, start))
  await first
  await h.controller.confirm()
  expect(h.creates).toBe(1)
  expect(h.saved).toBeNull()
  expect(h.controller.getSnapshot().position?.fill.outputAmountRaw).toBe('9007199254740993123')
})
test('failed pending-state persistence prevents sending a fill', async () => {
  const h = harness()
  h.save = async () => {
    throw new Error('Storage full')
  }
  await h.controller.restore()
  await h.controller.prepare()
  await h.controller.confirm()
  expect(h.creates).toBe(0)
  expect(h.controller.getSnapshot().error).toContain('No fill was submitted')
})
test('background while saving cancels before submit and leaves the controller locked until persistence finishes', async () => {
  const h = harness()
  const persistence = deferred<void>()
  h.save = async () => persistence.promise
  await h.controller.restore()
  await h.controller.prepare()
  const confirm = h.controller.confirm()
  h.controller.invalidate()
  expect(h.controller.getSnapshot().busy).toBe(true)
  persistence.resolve()
  await confirm
  expect(h.creates).toBe(0)
  expect(h.controller.getSnapshot().busy).toBe(false)
})
test('lost create response reconciles the exact quote rather than resubmitting', async () => {
  const h = harness()
  await h.controller.restore()
  await h.controller.prepare()
  const q = h.controller.getSnapshot().quote
  if (!q) throw new Error('Expected quote')
  h.lookup = paperPositionFixture(q)
  h.create = async () => {
    throw new Error('Timed out')
  }
  await h.controller.confirm()
  expect(h.creates).toBe(1)
  expect(h.controller.getSnapshot().position?.entryQuote.id).toBe(q.id)
  expect(h.saved).toBeNull()
})
test('an absent lookup cannot prove an in-flight fill failed and blocks another submission', async () => {
  const h = harness()
  h.create = async () => {
    throw new Error('Timed out')
  }
  await h.controller.restore()
  await h.controller.prepare()
  await h.controller.confirm()
  expect(h.controller.getSnapshot().pending).not.toBeNull()
  await h.controller.prepare()
  await h.controller.confirm()
  expect(h.creates).toBe(1)
  expect(h.controller.getSnapshot().error).toContain('uncertain')
})
test('restart restores an expired pending quote for lookup, without replaying create', async () => {
  const h = harness()
  const q = paperQuoteFixture(start)
  h.saved = { quoteId: q.id, signalId: q.signalId, sizeLamports: q.inputAmountLamports }
  h.lookup = paperPositionFixture(q)
  h.time = start + 30_000
  await h.controller.restore()
  expect(h.creates).toBe(0)
  expect(h.controller.getSnapshot().position?.entryQuote.id).toBe(q.id)
})
test('definitive rejection clears pending state and requires a new quote', async () => {
  const h = harness()
  h.create = async () => {
    throw new ApiError(409, 'STALE_SIGNAL', 'Pool checks expired')
  }
  await h.controller.restore()
  await h.controller.prepare()
  await h.controller.confirm()
  expect(h.saved).toBeNull()
  expect(h.controller.getSnapshot().pending).toBeNull()
  expect(h.controller.getSnapshot().quote).toBeNull()
  expect(h.controller.getSnapshot().error).toBe('Pool checks expired')
})
