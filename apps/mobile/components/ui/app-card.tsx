import type { PropsWithChildren } from 'react'
import { View, type ViewProps } from 'react-native'
import { useThemeColor } from '@/hooks/use-theme-color'

export function AppCard({ children, style, ...props }: PropsWithChildren<ViewProps>) {
  const backgroundColor = useThemeColor({}, 'surface')
  const borderColor = useThemeColor({}, 'border')
  return (
    <View
      {...props}
      style={[{ backgroundColor, borderColor, borderWidth: 1, borderRadius: 22, padding: 20, gap: 12 }, style]}
    >
      {children}
    </View>
  )
}
