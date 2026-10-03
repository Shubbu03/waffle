/** Push-token API for issue #24. Logs paths, never tokens. */
import { pushTokenResponseSchema } from '@waffle/shared'
import { apiRequest } from './api-client'
import { ApiError } from './api-error'

export const PUSH_ID_KEY = 'waffle.push-token-id.v1'

export type PushTokenRegistration = {
  token: string
  platform: 'android'
  notificationPermission: 'granted' | 'denied'
}

/** Register this device for the session owner; 409 also covers another owner's token. */
export async function registerPushToken(token: string, body: PushTokenRegistration): Promise<{ id: string }> {
  console.log(`[push-api] registerPushToken: permission=${body.notificationPermission}`)
  const payload = await apiRequest('/push-tokens', { method: 'POST', data: body }, token)
  const parsed = pushTokenResponseSchema.safeParse(payload)
  if (!parsed.success) throw new ApiError(0, 'BAD_RESPONSE', 'Malformed push-token response')
  console.log('[push-api] registerPushToken: registered')
  return { id: parsed.data.id }
}

/** Remove this device (bearer). 204 expected; anything else throws via apiRequest. */
export async function deletePushToken(token: string, id: string): Promise<void> {
  console.log('[push-api] deletePushToken: removing device')
  await apiRequest(`/push-tokens/${id}`, { method: 'DELETE' }, token)
  console.log('[push-api] deletePushToken: removed')
}
