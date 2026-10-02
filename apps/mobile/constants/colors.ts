/**
 * Waffle brand: lime base (#E4FF97) with black type.
 * Light mode is the brand statement (lime bg, black ink).
 * Dark mode inverts it (black bg, lime ink).
 */

export const Brand = {
  lime: '#E4FF97',
  limeSoft: '#F2FFC7',
  ink: '#000000',
} as const

export const Colors = {
  light: {
    background: Brand.lime,
    surface: Brand.limeSoft,
    border: Brand.ink,
    icon: Brand.ink,
    tabIconDefault: '#3A3A00',
    tabIconSelected: Brand.ink,
    text: Brand.ink,
    muted: '#3A3A00',
    tint: Brand.ink,
  },
  dark: {
    background: Brand.ink,
    surface: '#1C1C00',
    border: Brand.lime,
    icon: Brand.lime,
    tabIconDefault: '#8A8A5C',
    tabIconSelected: Brand.lime,
    text: Brand.lime,
    muted: '#B8C48A',
    tint: Brand.lime,
  },
}
