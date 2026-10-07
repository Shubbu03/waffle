import { useState } from 'react'
import { type ThemeMode, useAppTheme } from '@/components/app-theme'
import { SettingsDropdown, SettingsRow } from '@/components/settings/settings-ui'

const options: { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'system', label: 'System' },
]

export function SettingsUiTheme() {
  const { mode, setMode, isLoaded } = useAppTheme()
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
    <SettingsRow title="App theme" detail={saveError ? 'Theme changed, but could not be saved.' : undefined}>
      <SettingsDropdown
        label="App theme"
        value={options.find((option) => option.mode === mode)?.label ?? 'System'}
        disabled={!isLoaded}
        options={options.map((option) => ({
          label: option.label,
          value: option.mode,
          select: () => void choose(option.mode),
        }))}
      />
    </SettingsRow>
  )
}
