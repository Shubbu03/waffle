import { afterEach, describe, expect, test } from 'bun:test'
import { AppConfig } from '../constants/app-config'
import { summaryFixture } from '../test-support/signal-fixture'
import {
  ApiError,
  apiRequest,
  checkApiConnection,
  getSession,
  onUnauthorized,
  postLogout,
  postVerify,
} from './api-client'
import { listSignals } from './signals-api'
import { listWallets } from './wallets-api'

const originalApi = AppConfig.apiUrl
const originalDevelopment = typeof __DEV__ === 'undefined' ? undefined : __DEV__
let server: ReturnType<typeof Bun.serve> | undefined
let unsubscribe: (() => void) | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
  unsubscribe?.()
  unsubscribe = undefined
  AppConfig.apiUrl = originalApi
  Object.assign(globalThis, { __DEV__: originalDevelopment })
})
function api(handler: (request: Request) => Response | Promise<Response>) {
  Object.assign(globalThis, { __DEV__: true })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  AppConfig.apiUrl = `http://127.0.0.1:${server.port}`
}
const session = {
  userId: '11111111-1111-4111-8111-111111111111',
  walletAddress: '1'.repeat(32),
  expiresAt: '2026-10-08T10:00:00Z',
}
const input = {
  accountAddress: session.walletAddress,
  signedMessageBase64: 'bWVzc2FnZQ==',
  signatureBase64: `${'A'.repeat(86)}==`,
}

describe('mobile API wire integration', () => {
  test('wallet history sends wallet and cursor filters in both views, with bearer only for Following', async () => {
    const signal = summaryFixture('12')
    const requests: { view: string | null; wallet: string | null; cursor: string | null; auth: string | null }[] = []
    api((request) => {
      const url = new URL(request.url)
      requests.push({
        view: url.searchParams.get('view'),
        wallet: url.searchParams.get('walletId'),
        cursor: url.searchParams.get('cursor'),
        auth: request.headers.get('authorization'),
      })
      return Response.json({
        view: url.searchParams.get('view'),
        direction: 'before',
        items: [signal],
        nextCursor: '12',
        hasMore: false,
      })
    })
    for (const view of ['all', 'following'] as const)
      expect((await listSignals({ view, walletId: signal.walletId, cursor: '13' }, 'a'.repeat(43))).items).toEqual([
        signal,
      ])
    expect(requests).toEqual([
      { view: 'all', wallet: signal.walletId, cursor: '13', auth: null },
      { view: 'following', wallet: signal.walletId, cursor: '13', auth: `Bearer ${'a'.repeat(43)}` },
    ])
  })
  test('wallet history rejects mixed-wallet responses and invalid wallet IDs before any request', async () => {
    const signal = summaryFixture()
    let requests = 0
    api(() => {
      requests++
      return Response.json({ view: 'all', direction: 'before', items: [signal], nextCursor: null, hasMore: false })
    })
    await expect(listSignals({ view: 'all', walletId: 'bad' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(requests).toBe(0)
    await expect(listSignals({ view: 'all', walletId: crypto.randomUUID() })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    })
    expect(requests).toBe(1)
  })
  test('catalog retries can recover from a server failure and cancelled reads do not send another request', async () => {
    const wallet = {
      id: session.userId,
      address: session.walletAddress,
      label: 'Tracked wallet',
      active: true,
      source: 'catalog' as const,
      inclusionReason: 'Reviewed supported buys',
      recentSupportedActivityAt: null,
    }
    let requests = 0
    api((request) => {
      expect(new URL(request.url).pathname).toBe('/wallets')
      expect(request.headers.get('authorization')).toBeNull()
      requests++
      return requests === 1
        ? Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { status: 500 })
        : Response.json({ items: [wallet] })
    })
    await expect(listWallets()).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' })
    expect(await listWallets()).toEqual([wallet])
    const controller = new AbortController()
    const reason = new Error('Catalog screen left')
    controller.abort(reason)
    await expect(listWallets(controller.signal)).rejects.toBe(reason)
    expect(requests).toBe(2)
  })
  test('sign-in readiness checks the public health endpoint without wallet credentials', async () => {
    const requests: { path: string; authorization: string | null }[] = []
    api((request) => {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization') })
      return Response.json({ status: 'ok' })
    })
    await checkApiConnection()
    expect(requests).toEqual([{ path: '/health', authorization: null }])
  })
  test('a reachable but unready service cannot pass the sign-in readiness check', async () => {
    let payload: unknown = { status: 'starting' }
    api(() => Response.json(payload))
    await expect(checkApiConnection()).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
    payload = null
    await expect(checkApiConnection()).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })
  test('sign-in readiness retains API failures and unreachable connection errors', async () => {
    api(() =>
      Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service is restarting' } }, { status: 503 }),
    )
    await expect(checkApiConnection()).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' })
    server?.stop(true)
    await expect(checkApiConnection()).rejects.toMatchObject({ status: 0, code: 'NETWORK_UNAVAILABLE' })
  })
  test('reads the shared nested error envelope rather than replacing its useful message', async () => {
    api(() => Response.json({ error: { code: 'STALE_SIGNAL', message: 'Signal evidence is stale' } }, { status: 409 }))
    await expect(apiRequest('/signals')).rejects.toMatchObject({
      status: 409,
      code: 'STALE_SIGNAL',
      message: 'Signal evidence is stale',
    })
  })
  test('sign-in sends only signed wallet data and validates the issued session', async () => {
    let body: unknown
    api(async (request) => {
      body = await request.json()
      return Response.json({ session, accessToken: 'a'.repeat(43) })
    })
    expect(await postVerify(input)).toEqual({ session, accessToken: 'a'.repeat(43) })
    expect(body).toEqual(input)
  })
  test('malformed tokens and mismatched wallet sessions cannot complete sign-in', async () => {
    let payload: unknown = { session, accessToken: '' }
    api(() => Response.json(payload))
    await expect(postVerify(input)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
    payload = {
      session: { ...session, walletAddress: 'So11111111111111111111111111111111111111112' },
      accessToken: 'a'.repeat(43),
    }
    await expect(postVerify(input)).rejects.toThrow('different wallet')
  })
  test('the bearer token stays in the header and a 401 invalidates exactly that token', async () => {
    const token = 'a'.repeat(43)
    const unauthorized: string[] = []
    const captured: { url: string; authorization: string | null } = { url: '', authorization: null }
    unsubscribe = onUnauthorized((value) => unauthorized.push(value))
    api((request) => {
      captured.url = request.url
      captured.authorization = request.headers.get('authorization')
      return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }, { status: 401 })
    })
    await expect(getSession(token)).rejects.toBeInstanceOf(ApiError)
    expect(captured.authorization).toBe(`Bearer ${token}`)
    expect(captured.url).not.toContain(token)
    expect(unauthorized).toEqual([token])
  })
  test('restored session responses are validated before authentication', async () => {
    api(() => Response.json({ session: { ...session, expiresAt: 'garbage' } }))
    await expect(getSession('a'.repeat(43))).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })
  test('logout accepts an empty 204 and the next public request carries no bearer token', async () => {
    const authorizations: (string | null)[] = []
    api((request) => {
      authorizations.push(request.headers.get('authorization'))
      return request.method === 'POST' ? new Response(null, { status: 204 }) : Response.json({ items: [] })
    })
    await postLogout('a'.repeat(43))
    expect(await apiRequest('/wallets')).toEqual({ items: [] })
    expect(authorizations).toEqual([`Bearer ${'a'.repeat(43)}`, null])
  })
  test('unreachable transport is actionable and cancelled reads retain their cancellation reason', async () => {
    api(() => Response.json({ items: [] }))
    server?.stop(true)
    await expect(apiRequest('/wallets')).rejects.toMatchObject({ status: 0, code: 'NETWORK_UNAVAILABLE' })
    const controller = new AbortController()
    const reason = new Error('Screen left')
    controller.abort(reason)
    await expect(apiRequest('/wallets', { signal: controller.signal })).rejects.toBe(reason)
  })
  test('malformed JSON remains an API error', async () => {
    api(() => new Response('{broken', { headers: { 'content-type': 'application/json' } }))
    await expect(apiRequest('/signals')).rejects.toMatchObject({ status: 200, code: 'BAD_RESPONSE' })
  })
})
