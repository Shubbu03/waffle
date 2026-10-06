import { createHttpClient, type HttpRequest, HttpResponseError } from '@waffle/http'
import { type AuthVerifyRequest, apiErrorSchema, authVerifyResponseSchema, sessionSchema } from '@waffle/shared'
import { AppConfig } from '@/constants/app-config'
import { ApiError } from './api-error'

export { ApiError } from './api-error'
export type VerifyRequest = AuthVerifyRequest
const unauthorizedListeners = new Set<(token: string) => void>()
const mobileClient = createHttpClient({ timeoutMs: 10_000 })

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

export async function apiRequest(path: string, init: Omit<HttpRequest, 'url' | 'onResponse'> = {}, token?: string) {
  const baseUrl = apiBaseUrl()
  try {
    const response = await mobileClient.request({
      ...init,
      url: `${baseUrl}${path}`,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      onResponse(status) {
        if (status === 401 && token) reportUnauthorized(token)
      },
    })
    if (response.status < 200 || response.status >= 300) {
      const parsed = apiErrorSchema.safeParse(response.data)
      throw new ApiError(
        response.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
        parsed.success ? parsed.data.error.message : `Request to ${path} failed`,
      )
    }
    return response.data
  } catch (error) {
    if (error instanceof HttpResponseError)
      throw new ApiError(error.status, 'BAD_RESPONSE', `Invalid response from ${path}`)
    if (error instanceof ApiError || init.signal?.aborted) throw error
    throw new ApiError(0, 'NETWORK_UNAVAILABLE', 'Unable to reach waffle. Check your connection and try again.')
  }
}

export async function postVerify(request: VerifyRequest) {
  const payload = await apiRequest('/auth/verify', { method: 'POST', data: request })
  const parsed = authVerifyResponseSchema.safeParse(payload)
  if (!parsed.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed sign-in response')
  if (parsed.data.session.walletAddress !== request.accountAddress) {
    throw new ApiError(0, 'BAD_RESPONSE', 'The session belongs to a different wallet.')
  }
  return parsed.data
}

export async function checkApiConnection(signal?: AbortSignal): Promise<void> {
  const payload = await apiRequest('/health', { signal })
  if (!payload || typeof payload !== 'object' || !('status' in payload) || payload.status !== 'ok') {
    throw new ApiError(0, 'BAD_RESPONSE', 'The waffle service is not ready yet. Try again shortly.')
  }
}

export async function getSession(token: string) {
  const payload = await apiRequest('/auth/session', {}, token)
  const parsed = sessionSchema.safeParse(
    payload !== null && typeof payload === 'object' && 'session' in payload ? payload.session : null,
  )
  if (!parsed.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed session response')
  return parsed.data
}

export async function postLogout(token: string): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' }, token)
}
