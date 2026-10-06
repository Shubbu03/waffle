import { ActivityIndicator, Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { AppText } from '@/components/app-text'
import { useThemeColor } from '@/hooks/use-theme-color'

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  style,
}: {
  title: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'quiet'
  disabled?: boolean
  busy?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const accent = useThemeColor({}, 'accent')
  const surface = useThemeColor({}, 'surfaceMuted')
  const ink = useThemeColor({}, 'text')
  const accentText = useThemeColor({}, 'accentText')
  const color = variant === 'primary' ? accentText : ink
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 48,
          borderRadius: 16,
          paddingHorizontal: 18,
          paddingVertical: 13,
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          backgroundColor: variant === 'primary' ? accent : variant === 'secondary' ? surface : 'transparent',
          opacity: disabled || busy ? 0.5 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : null}
      <AppText type="defaultSemiBold" style={{ color, fontSize: 14, textAlign: 'center' }}>
        {title}
      </AppText>
    </Pressable>
  )
}
