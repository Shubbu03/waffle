import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { type ThemeMode, useAppTheme } from '@/components/app-theme'
import { useThemeColor } from '@/hooks/use-theme-color'

const options: { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'system', label: 'System' },
]

export function SettingsUiTheme() {
  const { mode, setMode, isLoaded } = useAppTheme()
  const accent = useThemeColor({}, 'accent')
  const accentText = useThemeColor({}, 'accentText')
  const surface = useThemeColor({}, 'surfaceMuted')
  const ink = useThemeColor({}, 'text')
  const danger = useThemeColor({}, 'danger')
  const [saveError, setSaveError] = useState(false)
  const choose = async (next: ThemeMode) => {
    setSaveError(false)
    try {
      await setMode(next)
    } catch {
      setSaveError(true)
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <AppText type="subtitle">App theme</AppText>
      <View accessibilityRole="radiogroup" accessibilityLabel="App theme" style={{ flexDirection: 'row', gap: 8 }}>
        {options.map((option) => {
          const selected = option.mode === mode
          return (
            <Pressable
              key={option.mode}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: !isLoaded }}
              accessibilityLabel={option.label}
              disabled={!isLoaded}
              onPress={() => void choose(option.mode)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 48,
                paddingVertical: 13,
                borderRadius: 16,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: selected ? accent : surface,
                opacity: !isLoaded ? 0.5 : pressed ? 0.75 : 1,
              })}
            >
              <AppText type="defaultSemiBold" style={{ color: selected ? accentText : ink, fontSize: 14 }}>
                {option.label}
              </AppText>
            </Pressable>
          )
        })}
      </View>
      {saveError ? (
        <AppText style={{ color: danger, fontSize: 13 }} accessibilityLiveRegion="polite">
          Theme changed, but the preference could not be saved.
        </AppText>
      ) : null}
    </View>
  )
}
