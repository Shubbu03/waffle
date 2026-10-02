import { afterEach, describe, expect, test } from 'bun:test'
import { AppConfig } from '../constants/app-config'
import { ApiError, apiRequest, getSession, onUnauthorized, postLogout, postVerify } from './api-client'

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
  test('malformed JSON remains an API error', async () => {
    api(() => new Response('{broken', { headers: { 'content-type': 'application/json' } }))
    await expect(apiRequest('/signals')).rejects.toMatchObject({ status: 200, code: 'BAD_RESPONSE' })
  })
})
