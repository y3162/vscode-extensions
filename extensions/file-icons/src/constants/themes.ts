export const themeFlavors = {
  light: 'latte',
  dark: 'frappe',
} as const

export type ThemeName = keyof typeof themeFlavors
