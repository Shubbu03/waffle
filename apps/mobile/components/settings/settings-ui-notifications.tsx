import { useState } from 'react'
import { Alert, Linking, Switch } from 'react-native'
import { useAuth } from '@/components/auth/auth-provider'
import { usePush } from '@/components/push/push-provider'
import { SettingsRow } from '@/components/settings/settings-ui'
import { useThemeColor } from '@/hooks/use-theme-color'

export function SettingsUiNotifications() {
  const { session } = useAuth()
  const push = usePush()
  const [saving, setSaving] = useState(false)
  const accent = useThemeColor({}, 'accent')
  const surface = useThemeColor({}, 'surfaceMuted')
  const ink = useThemeColor({}, 'accentText')
  const detail = !session
    ? 'Sign in to enable alerts.'
    : push.enabled && push.permission === 'denied'
      ? 'Allow notifications in Android settings.'
      : push.registrationUnavailable
        ? push.enabled
          ? 'Alerts unavailable. Retrying automatically.'
          : 'Off on this device. Cleanup will retry.'
        : push.isRegistering
          ? 'Updating…'
          : undefined
  const change = async (enabled: boolean) => {
    setSaving(true)
    try {
      await push.setEnabled(enabled)
      if (enabled && push.permission === 'denied') await Linking.openSettings()
    } catch {
      Alert.alert('Notifications', 'Could not update notifications. Try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <SettingsRow title="Notifications" detail={detail}>
      <Switch
        accessibilityLabel="Notifications"
        value={push.enabled === true && push.permission === 'granted'}
        disabled={!session || saving || push.enabled === null || push.permission === 'checking'}
        trackColor={{ false: surface, true: accent }}
        thumbColor={push.enabled ? ink : undefined}
        onValueChange={(value) => void change(value)}
      />
    </SettingsRow>
  )
}
