import { View, type ViewProps } from 'react-native'
import { useThemeColor } from '@/hooks/use-theme-color'

export function AppView({ style, ...otherProps }: ViewProps) {
  const backgroundColor = useThemeColor({}, 'background')

  return <View style={[{ backgroundColor, gap: 8 }, style]} {...otherProps} />
}
