import { StyleSheet, Text, type TextProps } from 'react-native'
import { FontFamily, type FontFamilyName } from '@/constants/fonts'
import { useThemeColor } from '@/hooks/use-theme-color'

export type AppTextProps = TextProps & {
  lightColor?: string
  darkColor?: string
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link'
  family?: FontFamilyName
}

export function AppText({ style, lightColor, darkColor, type = 'default', family, ...rest }: AppTextProps) {
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text')
  const resolvedFamily = family ?? FontFamily.sans

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
    fontFamily: FontFamily.sansMedium,
  },
  title: {
    fontSize: 30,
    fontFamily: FontFamily.sansMedium,
    lineHeight: 36,
  },
  subtitle: {
    fontSize: 20,
    fontFamily: FontFamily.sansMedium,
  },
  link: {
    lineHeight: 30,
    fontSize: 16,
    textDecorationLine: 'underline',
  },
})
