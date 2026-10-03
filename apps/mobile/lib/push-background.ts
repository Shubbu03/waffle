/** Killed/background tap sink for issue #24. Imported for side effects at bundle load
 * (see app/_layout.tsx) — RNFirebase requires this outside any component. */
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging'

let registered = false

export function registerPushBackgroundHandler(): void {
  if (registered) {
    console.log('[push] background handler already registered')
    return
  }
  registered = true
  setBackgroundMessageHandler(getMessaging(), async (message) => {
    // Keep it minimal: the OS shows the notification; navigation happens on tap
    // via getInitialNotification/onNotificationOpenedApp in the provider.
    console.log(`[push] background message: ${message.messageId ?? 'no-id'}`)
  })
  console.log('[push] background handler registered')
}
