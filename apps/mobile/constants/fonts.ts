/**
 * Waffle type: system sans for UI/body, system serif for display headlines.
 * Android resolves these to Roboto / Noto Serif — no font assets needed.
 */

export const FontFamily = {
  sans: 'sans-serif',
  sansMedium: 'sans-serif-medium',
  serif: 'serif',
} as const

export type FontFamilyName = keyof typeof FontFamily
