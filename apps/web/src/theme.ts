export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';
export const THEME_STORAGE_KEY = 'design-index-theme';
export const THEME_COLORS: Record<Theme, string> = { light: '#f5f4ef', dark: '#121814' };

export function readThemePreference(read = () => window.localStorage.getItem(THEME_STORAGE_KEY)): ThemePreference {
  try {
    const value = read();
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): Theme {
  return preference === 'system' ? (systemIsDark ? 'dark' : 'light') : preference;
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch { /* Private/restricted storage must not prevent an in-session theme change. */ }
}

export function applyTheme(theme: Theme, preference: ThemePreference): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}
