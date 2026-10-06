import { useAppTheme } from '@/components/app-theme'

export function useColorScheme() {
  return useAppTheme().colorScheme
}
