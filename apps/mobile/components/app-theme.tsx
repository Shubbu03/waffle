import AsyncStorage from '@react-native-async-storage/async-storage'
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { createContext, type PropsWithChildren, use, useCallback, useEffect, useRef, useState } from 'react'
import { Appearance, Platform, useColorScheme } from 'react-native'
import { Colors } from '@/constants/colors'

export type ThemeMode = 'light' | 'dark' | 'system'
const THEME_KEY = 'waffle.theme-mode'
type AppThemeState = {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => Promise<void>
  isLoaded: boolean
  colorScheme: 'light' | 'dark'
  isDark: boolean
  theme: typeof themes.light | typeof themes.dark
}
const Context = createContext<AppThemeState | null>(null)

const themes = {
  light: {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      primary: Colors.light.tint,
      background: Colors.light.background,
      card: Colors.light.surface,
      text: Colors.light.text,
      border: Colors.light.border,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: Colors.dark.tint,
      background: Colors.dark.background,
      card: Colors.dark.surface,
      text: Colors.dark.text,
      border: Colors.dark.border,
    },
  },
}
export function useAppTheme() {
  const value = use(Context)
  if (!value) throw new Error('useAppTheme must be wrapped in AppTheme')
  return value
}
export function AppTheme({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme()
  const [mode, setPreference] = useState<ThemeMode>('system')
  const [isLoaded, setIsLoaded] = useState(false)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const userSelected = useRef(false)
  useEffect(() => {
    let cancelled = false
    void AsyncStorage.getItem(THEME_KEY)
      .then((saved) => {
        if (!cancelled && !userSelected.current && (saved === 'light' || saved === 'dark' || saved === 'system')) {
          setPreference(saved)
        }
      })
      .catch(() => console.warn('[theme] saved preference unavailable'))
      .finally(() => {
        if (!cancelled) setIsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])
  const setMode = useCallback((next: ThemeMode) => {
    userSelected.current = true
    setPreference(next)
    const write = writes.current.then(() => AsyncStorage.setItem(THEME_KEY, next))
    writes.current = write.catch(() => {})
    return write
  }, [])
  useEffect(() => {
    if (isLoaded && Platform.OS !== 'web') Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode)
  }, [mode, isLoaded])
  const colorScheme =
    mode === 'system' ? (systemScheme === 'dark' && (Platform.OS !== 'web' || isLoaded) ? 'dark' : 'light') : mode
  const theme = themes[colorScheme]
  return (
    <Context value={{ mode, setMode, isLoaded, colorScheme, isDark: colorScheme === 'dark', theme }}>
      <ThemeProvider value={theme}>{children}</ThemeProvider>
    </Context>
  )
}
