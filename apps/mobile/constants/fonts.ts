/**
 * Waffle type: system sans for UI/body, system serif for display headlines.
 * Android resolves these to Roboto / Noto Serif — no font assets needed.
 */

export const FontFamily = {
  sans: 'Poppins',
  sansMedium: 'Poppins-Medium',
  sansLight: 'Poppins-Light',
  serif: 'serif',
  /** Handwritten wordmark (Playwrite ZA Regular) — waffle logo text only. */
  wordmark: 'PlaywriteZA',
} as const

export type FontFamilyName = keyof typeof FontFamily
