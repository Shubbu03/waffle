import { type AuthVerifyRequest, apiErrorSchema, authVerifyResponseSchema, sessionSchema } from '@waffle/shared'
import { AppConfig } from '@/constants/app-config'
import { ApiError } from './api-error'

export { ApiError } from './api-error'
export type VerifyRequest = AuthVerifyRequest
const unauthorizedListeners = new Set<(token: string) => void>()

export function reportUnauthorized(token: string): void {
  for (const listener of unauthorizedListeners) listener(token)
}

export function onUnauthorized(listener: (token: string) => void): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

export function apiBaseUrl(): string {
  if (!AppConfig.apiUrl) throw new Error('Configure EXPO_PUBLIC_WAFFLE_API_URL before connecting to the API.')
  const url = new URL(AppConfig.apiUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && __DEV__)) {
    throw new Error('The API URL must use HTTPS outside development.')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid API base URL.')
  return AppConfig.apiUrl
}

export async function apiFetch(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  init.signal?.addEventListener('abort', abort, { once: true })
  if (init.signal?.aborted) abort()
  const timeout = setTimeout(abort, 10_000)
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers, signal: controller.signal })
    if (response.status === 401 && token) {
      reportUnauthorized(token)
    }
    return response
  } finally {
    clearTimeout(timeout)
    init.signal?.removeEventListener('abort', abort)
  }
}

export async function readJson(response: Response, path: string): Promise<unknown> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError(response.status, 'BAD_RESPONSE', `Invalid response from ${path}`)
  }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new ApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      parsed.success ? parsed.data.error.message : `Request to ${path} failed`,
    )
  }
  return payload
}

export async function postVerify(request: VerifyRequest) {
  const response = await apiFetch('/auth/verify', { method: 'POST', body: JSON.stringify(request) })
  const parsed = authVerifyResponseSchema.safeParse(await readJson(response, '/auth/verify'))
  if (!parsed.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed sign-in response')
  if (parsed.data.session.walletAddress !== request.accountAddress) {
    throw new ApiError(0, 'BAD_RESPONSE', 'The session belongs to a different wallet.')
  }
  return parsed.data
}

export async function getSession(token: string) {
  const response = await apiFetch('/auth/session', {}, token)
  const payload = await readJson(response, '/auth/session')
  const parsed = sessionSchema.safeParse(
    payload !== null && typeof payload === 'object' && 'session' in payload ? payload.session : null,
  )
  if (!parsed.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed session response')
  return parsed.data
}

export async function postLogout(token: string): Promise<void> {
  const response = await apiFetch('/auth/logout', { method: 'POST' }, token)
  if (response.status !== 204) await readJson(response, '/auth/logout')
}
