import { afterEach, expect, test } from 'bun:test'
import { realOrderSchema, tradeAttemptSchema, WRAPPED_SOL_MINT } from '@waffle/shared'
import { AppConfig } from '../constants/app-config'
import { createTradeAttempt, executeTradeAttempt, getTradeAttempt } from '../lib/trade-api'
import { paperQuoteFixture } from './fixtures/paper-fixture'

const originalUrl = AppConfig.apiUrl
const originalDevelopment = typeof __DEV__ === 'undefined' ? undefined : __DEV__
const token = 'a'.repeat(43)
let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  server?.stop(true)
  AppConfig.apiUrl = originalUrl
  Object.assign(globalThis, { __DEV__: originalDevelopment })
})
function api(response: (request: Request) => unknown) {
  Object.assign(globalThis, { __DEV__: true })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      expect(request.headers.get('authorization')).toBe(`Bearer ${token}`)
      return Response.json(response(request))
    },
  })
  AppConfig.apiUrl = `http://127.0.0.1:${server.port}`
}
function fixture() {
  const quote: Record<string, unknown> = { ...paperQuoteFixture(Date.now(), '10000000') }
  delete quote.providerQuoteId
  delete quote.outputDecimals
  const order = realOrderSchema.parse({
    ...quote,
    kind: 'real',
    taker: WRAPPED_SOL_MINT,
    signatureFeePayer: WRAPPED_SOL_MINT,
    prioritizationFeePayer: WRAPPED_SOL_MINT,
    rentFeePayer: WRAPPED_SOL_MINT,
    gasless: false,
    requiredSignatures: 1,
    lastValidBlockHeight: '123',
    transactionBase64: 'AQID',
  })
  const attempt = tradeAttemptSchema.parse({
    id: crypto.randomUUID(),
    signalId: order.signalId,
    quoteId: order.id,
    requestId: order.requestId,
    taker: order.taker,
    router: order.router,
    inputAmountLamports: order.inputAmountLamports,
    status: 'prepared',
    signature: null,
    executeCode: null,
    failureReason: null,
    createdAt: order.fetchedAt,
    updatedAt: order.fetchedAt,
  })
  return { order, attempt }
}

test('real review rejects malformed or mismatched server orders before wallet signing', async () => {
  const good = fixture()
  let response: unknown = good
  api(() => response)
  expect(await createTradeAttempt(token, good.order.signalId, good.order.inputAmountLamports)).toEqual(good)
  for (const invalid of [
    null,
    { order: null, attempt: {} },
    { ...good, order: { ...good.order, requiredSignatures: 2 } },
    { ...good, attempt: { ...good.attempt, quoteId: crypto.randomUUID() } },
    { ...good, order: { ...good.order, signalId: crypto.randomUUID() } },
  ]) {
    response = invalid
    await expect(createTradeAttempt(token, good.order.signalId, good.order.inputAmountLamports)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    })
  }
})

test('execution responses must match the submitted attempt and quote', async () => {
  const { order, attempt } = fixture()
  let response: unknown = { ...attempt, id: crypto.randomUUID() }
  api(() => response)
  const body = { quoteId: order.id, requestId: order.requestId, signedTransactionBase64: 'AQID' }
  await expect(executeTradeAttempt(token, attempt.id, body)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  response = { ...attempt, status: 'failed', failureReason: 'Execution rejected' }
  expect((await executeTradeAttempt(token, attempt.id, body)).status).toBe('failed')
})

test('a lost execution response can be checked with GET without replaying the purchase', async () => {
  const { attempt } = fixture()
  let response: unknown = { ...attempt, id: crypto.randomUUID() }
  let calls = 0
  api((request) => {
    expect(request.method).toBe('GET')
    expect(new URL(request.url).pathname).toBe(`/trade-attempts/${attempt.id}`)
    calls++
    return response
  })
  await expect(getTradeAttempt(token, attempt.id)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  response = attempt
  expect(await getTradeAttempt(token, attempt.id)).toEqual(attempt)
  expect(calls).toBe(2)
})

test('execution waits beyond the general ten-second mobile deadline and sends only once', async () => {
  const { order, attempt } = fixture()
  Object.assign(globalThis, { __DEV__: true })
  let calls = 0
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      expect(request.method).toBe('POST')
      expect(new URL(request.url).pathname).toBe(`/trade-attempts/${attempt.id}/execute`)
      calls++
      await Bun.sleep(10_100)
      return Response.json({ ...attempt, status: 'failed', failureReason: 'Execution rejected' })
    },
  })
  AppConfig.apiUrl = `http://127.0.0.1:${server.port}`
  const result = await executeTradeAttempt(token, attempt.id, {
    quoteId: order.id,
    requestId: order.requestId,
    signedTransactionBase64: 'AQID',
  })
  expect(result.status).toBe('failed')
  expect(calls).toBe(1)
}, 15_000)
