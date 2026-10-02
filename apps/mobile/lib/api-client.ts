/** Waffle API client for issue #21. Thin fetch wrapper; logs method+path+status, never tokens. */
import { AppConfig } from '@/constants/app-config'
import { ApiError } from './api-error'

export { ApiError } from './api-error'

export type VerifyRequest = {
  accountAddress: string
  signedMessageBase64: string
  signatureBase64: string
}

export type VerifyResponse = {
  session: { userId: string; walletAddress: string; expiresAt: string }
  accessToken: string
}

function baseUrl(): string {
  console.log('[api] baseUrl: reading AppConfig.apiUrl')
  if (!AppConfig.apiUrl) {
    throw new Error('Set EXPO_PUBLIC_WAFFLE_API_URL to the API base URL before signing in.')
  }
  return AppConfig.apiUrl
}

/** Shared by feature clients for authed GET/PUT/DELETE. Logs path+status, never tokens. */
export async function apiFetch(path: string, init: RequestInit, token?: string): Promise<Response> {
  const url = `${baseUrl()}${path}`
  console.log(`[api] apiFetch: ${init.method ?? 'GET'} ${path}`)
  const started = Date.now()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { ...init, headers })
  console.log(`[api] apiFetch: ${path} -> ${response.status} in ${Date.now() - started}ms`)
  return response
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${baseUrl()}${path}`
  console.log(`[api] postJson: POST ${path}`)
  const started = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const elapsed = Date.now() - started
  console.log(`[api] postJson: ${path} -> ${response.status} in ${elapsed}ms`)
  return (await readJson(response, path)) as T
}

export async function readJson(response: Response, path: string): Promise<unknown> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    throw new ApiError(response.status, 'BAD_RESPONSE', `Invalid JSON from ${path}`)
  }
  if (!response.ok) {
    const record = (payload ?? {}) as { code?: unknown; message?: unknown }
    throw new ApiError(
      response.status,
      typeof record.code === 'string' ? record.code : 'REQUEST_FAILED',
      typeof record.message === 'string' ? record.message : `Request to ${path} failed`,
    )
  }
  return payload
}

/** Trade the wallet signature for a session. 401 = stale/forged message. */
export async function postVerify(request: VerifyRequest): Promise<VerifyResponse> {
  console.log(
    `[api] postVerify: account=${request.accountAddress.slice(0, 8)}... ` +
      `msgB64=${request.signedMessageBase64.length}B sigB64=${request.signatureBase64.length}B`,
  )
  console.log('[api] postVerify: submitting signature')
  const payload = (await postJson<VerifyResponse>('/auth/verify', request)) as VerifyResponse
  if (typeof payload?.accessToken !== 'string' || typeof payload?.session !== 'object' || payload.session === null) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed verify response')
  }
  console.log('[api] postVerify: session issued')
  return payload
}

/** Validate the stored token; throws ApiError(401) when expired/invalid. */
export async function getSession(token: string): Promise<VerifyResponse['session']> {
  console.log('[api] getSession: validating token (value hidden)')
  const url = `${baseUrl()}/auth/session`
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  console.log(`[api] getSession: -> ${response.status}`)
  const payload = (await readJson(response, '/auth/session')) as { session: VerifyResponse['session'] }
  if (typeof payload?.session !== 'object' || payload.session === null) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed session response')
  }
  return payload.session
}

/** Tell the server to burn the token. Best-effort: network errors propagate, caller decides. */
export async function postLogout(token: string): Promise<void> {
  console.log('[api] postLogout: burning token (value hidden)')
  const url = `${baseUrl()}/auth/logout`
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  console.log(`[api] postLogout: -> ${response.status}`)
  if (response.status !== 204) {
    await readJson(response, '/auth/logout')
  }
}
