/** Waffle API client for issue #21. Thin fetch wrapper; logs method+path+status, never tokens. */
import { AppConfig } from '@/constants/app-config'
import { ApiError } from './api-error'

export { ApiError } from './api-error'

export type ChallengeResponse = {
  challengeId: string
  signInInput: Record<string, unknown>
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

async function readJson(response: Response, path: string): Promise<unknown> {
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

/** Step 1 of sign-in: fetch a server challenge (nonce included). */
export async function postChallenge(): Promise<ChallengeResponse> {
  console.log('[api] postChallenge: requesting challenge')
  const payload = (await postJson<ChallengeResponse>('/auth/challenge', {})) as ChallengeResponse
  if (
    typeof payload?.challengeId !== 'string' ||
    typeof payload?.signInInput !== 'object' ||
    payload.signInInput === null
  ) {
    throw new ApiError(0, 'BAD_RESPONSE', 'Malformed challenge response')
  }
  console.log('[api] postChallenge: challenge received')
  return payload
}

export type VerifyRequest = {
  challengeId: string
  accountAddress: string
  signedMessageBase64: string
  signatureBase64: string
}

/** Step 3 of sign-in: trade the wallet signature for a session. 401 = bad/expired challenge. */
export async function postVerify(request: VerifyRequest): Promise<VerifyResponse> {
  console.log(
    `[api] postVerify: challenge=${request.challengeId.slice(0, 8)}... account=${request.accountAddress.slice(0, 8)}... ` +
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
