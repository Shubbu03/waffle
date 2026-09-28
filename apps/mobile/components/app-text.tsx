import { StyleSheet, Text, type TextProps } from 'react-native'
import { useThemeColor } from '@/hooks/use-theme-color'
import { FontFamily, type FontFamilyName } from '@/constants/fonts'

export type AppTextProps = TextProps & {
  lightColor?: string
  darkColor?: string
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link'
  family?: FontFamilyName
}

export function AppText({ style, lightColor, darkColor, type = 'default', family, ...rest }: AppTextProps) {
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text')
  const resolvedFamily =
    family ?? (type === 'title' || type === 'subtitle' ? FontFamily.serif : FontFamily.sans)

  return (
    <Text
      style={[
        { color, fontFamily: resolvedFamily },
        type === 'default' ? styles.default : undefined,
        type === 'title' ? styles.title : undefined,
        type === 'defaultSemiBold' ? styles.defaultSemiBold : undefined,
        type === 'subtitle' ? styles.subtitle : undefined,
        type === 'link' ? styles.link : undefined,
        style,
      ]}
      {...rest}
    />
  )
}

const styles = StyleSheet.create({
  default: {
    fontSize: 16,
    lineHeight: 24,
  },
  defaultSemiBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  link: {
    lineHeight: 30,
    fontSize: 16,
    textDecorationLine: 'underline',
  },
})
