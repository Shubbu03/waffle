import { afterEach, expect, test } from 'bun:test'
import { AppConfig } from '../constants/app-config'
import {
  createPaperPosition,
  getPaperPosition,
  getPaperValuation,
  listPaperPositions,
  lookupPaperPosition,
  preparePaperQuote,
} from '../lib/paper-api'
import { PAPER_TEST_SIGNAL, paperPositionFixture, paperQuoteFixture } from './fixtures/paper-fixture'

const originalUrl = AppConfig.apiUrl
const originalDevelopment = typeof __DEV__ === 'undefined' ? undefined : __DEV__
const token = 'a'.repeat(43)
let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
  AppConfig.apiUrl = originalUrl
  Object.assign(globalThis, { __DEV__: originalDevelopment })
})
function api(handler: (request: Request) => Promise<Response> | Response) {
  Object.assign(globalThis, { __DEV__: true })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  AppConfig.apiUrl = `http://127.0.0.1:${server.port}`
}
test('paper API carries only owner session and exact string amounts across quote and fill', async () => {
  const quote = paperQuoteFixture()
  const position = paperPositionFixture(quote)
  const bodies: unknown[] = []
  api(async (request) => {
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`)
    expect(request.url).not.toContain(token)
    bodies.push(await request.json())
    return Response.json(new URL(request.url).pathname.endsWith('/quote') ? quote : position)
  })
  expect(await preparePaperQuote({ signalId: PAPER_TEST_SIGNAL, sizeLamports: '100000000' }, token)).toEqual(quote)
  expect(
    await createPaperPosition({ signalId: PAPER_TEST_SIGNAL, quoteId: quote.id, sizeLamports: '100000000' }, token),
  ).toEqual(position)
  expect(bodies).toEqual([
    { signalId: PAPER_TEST_SIGNAL, sizeLamports: '100000000' },
    { signalId: PAPER_TEST_SIGNAL, quoteId: quote.id, sizeLamports: '100000000' },
  ])
})
test('owner reads validate lookup, pagination, position, and unavailable valuation responses', async () => {
  const position = paperPositionFixture()
  api((request) => {
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`)
    const url = new URL(request.url)
    if (url.pathname.includes('/by-quote/')) return Response.json({ position })
    if (url.pathname.endsWith('/valuation'))
      return Response.json({ status: 'unavailable', positionId: position.id, reason: 'Unsupported route' })
    if (url.pathname.endsWith(position.id)) return Response.json(position)
    expect(url.searchParams.get('limit')).toBe('20')
    return Response.json({ items: [position], nextCursor: null })
  })
  expect((await listPaperPositions(token)).items).toEqual([position])
  expect(await getPaperPosition(position.id, token)).toEqual(position)
  expect(await lookupPaperPosition(position.entryQuote.id, token)).toEqual(position)
  expect(await getPaperValuation(position.id, token)).toMatchObject({
    status: 'unavailable',
    reason: 'Unsupported route',
  })
})
test('malformed and mismatched paper responses never become accepted review or recovery data', async () => {
  const quote = paperQuoteFixture()
  let payload: unknown = { ...quote, inputAmountLamports: '1' }
  api(() => Response.json(payload))
  await expect(
    preparePaperQuote({ signalId: PAPER_TEST_SIGNAL, sizeLamports: '100000000' }, token),
  ).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  payload = { items: [{ simulated: false }] }
  await expect(listPaperPositions(token)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  payload = { position: paperPositionFixture() }
  await expect(lookupPaperPosition(quote.id, token)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  payload = { status: 'unavailable', positionId: crypto.randomUUID(), reason: 'No route' }
  await expect(getPaperValuation(crypto.randomUUID(), token)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
})
