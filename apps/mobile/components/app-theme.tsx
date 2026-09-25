import { DarkTheme as AppThemeDark, DefaultTheme as AppThemeLight, ThemeProvider } from '@react-navigation/native'
import type { PropsWithChildren } from 'react'
import { useColorScheme } from 'react-native'

export function useAppTheme() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'
  const theme = isDark ? AppThemeDark : AppThemeLight
  return {
    colorScheme,
    isDark,
    theme,
  }
}

export function AppTheme({ children }: PropsWithChildren) {
  const { theme } = useAppTheme()

  return <ThemeProvider value={theme}>{children}</ThemeProvider>
}
