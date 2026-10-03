import notifee, { AndroidImportance, AuthorizationStatus } from '@notifee/react-native'
import { deleteToken, getMessaging, getToken } from '@react-native-firebase/messaging'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { AppConfig } from '@/constants/app-config'
import { type PushRegistration, PushRegistrationController } from './push-registration'
import type { PushPermission } from './push-tap'
import { deletePushToken, PUSH_ID_KEY, registerPushToken } from './push-tokens-api'
import { loadSession } from './session-store'

const REGISTRATION_KEY = 'waffle.push-registration.v2'
export const SIGNAL_CHANNEL = 'waffle-signals'

export async function readPushRegistration(): Promise<PushRegistration | null> {
  const raw = await SecureStore.getItemAsync(REGISTRATION_KEY)
  if (!raw) {
    const legacyId = await SecureStore.getItemAsync(PUSH_ID_KEY)
    const session = legacyId ? await loadSession() : null
    return legacyId && session
      ? {
          id: legacyId,
          userId: session.userId,
          apiUrl: AppConfig.apiUrl,
          token: '',
          rotationRequired: true,
        }
      : null
  }
  try {
    const record = JSON.parse(raw)
    return record && ['id', 'userId', 'apiUrl', 'token'].every((key) => typeof record[key] === 'string') ? record : null
  } catch {
    return null
  }
}

export async function readPushPermission(request = false): Promise<PushPermission> {
  await notifee.createChannel({ id: SIGNAL_CHANNEL, name: 'Whale alerts', importance: AndroidImportance.HIGH })
  const settings = request ? await notifee.requestPermission() : await notifee.getNotificationSettings()
  const channel = await notifee.getChannel(SIGNAL_CHANNEL)
  return settings.authorizationStatus === AuthorizationStatus.AUTHORIZED && !channel?.blocked ? 'granted' : 'denied'
}

export const pushDevice = new PushRegistrationController({
  apiUrl: AppConfig.apiUrl,
  load: readPushRegistration,
  save: async (record) => SecureStore.setItemAsync(REGISTRATION_KEY, JSON.stringify(record)),
  clear: async () => {
    await SecureStore.deleteItemAsync(REGISTRATION_KEY)
    await SecureStore.deleteItemAsync(PUSH_ID_KEY)
  },
  permission: readPushPermission,
  getToken: () => getToken(getMessaging()),
  rotate: async () => {
    if (Platform.OS !== 'android') return
    await notifee.cancelAllNotifications()
    await deleteToken(getMessaging())
  },
  register: (session, token, permission) =>
    registerPushToken(session.accessToken, {
      token,
      platform: 'android',
      notificationPermission: permission,
    }),
  remove: (session, id) => deletePushToken(session.accessToken, id),
})
