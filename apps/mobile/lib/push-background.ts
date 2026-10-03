import notifee, { EventType } from '@notifee/react-native'
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging'
import { Platform } from 'react-native'
import { queuePushTap, receivePush } from './push-notifications'

// Android Headless JS does not mount Expo Router's root layout.
if (Platform.OS === 'android') {
  setBackgroundMessageHandler(getMessaging(), async (message) => {
    try {
      await receivePush(message.data)
    } catch {
      console.warn('[push] background delivery unavailable')
    }
  })
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type !== EventType.PRESS) return
    try {
      await queuePushTap(detail.notification?.data)
    } catch {
      console.warn('[push] could not save notification tap')
    }
  })
}
