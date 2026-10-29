import { useEffect, useState } from 'react';
import { applyTheme, persistThemePreference, readThemePreference, resolveTheme, THEME_STORAGE_KEY } from './theme';
import type { ThemePreference } from './theme';

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [systemIsDark, setSystemIsDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = resolveTheme(preference, systemIsDark);

  useEffect(() => { applyTheme(theme, preference); }, [theme, preference]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => setSystemIsDark(media.matches);
    const onStorageChange = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setPreference(readThemePreference());
    };
    media.addEventListener('change', onSystemChange);
    window.addEventListener('storage', onStorageChange);
    onSystemChange();
    return () => { media.removeEventListener('change', onSystemChange); window.removeEventListener('storage', onStorageChange); };
  }, []);

  function choose(next: ThemePreference) {
    persistThemePreference(next);
    setPreference(next);
  }

  return <div className="theme-controls" role="group" aria-label="Color theme">
    <button type="button" className="theme-toggle" aria-label="Dark mode" aria-pressed={theme === 'dark'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => choose(theme === 'dark' ? 'light' : 'dark')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === 'dark' ? <path d="M20.6 13.3A8.6 8.6 0 0 1 10.7 3.4a8.7 8.7 0 1 0 9.9 9.9Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
      </svg>
      <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
    <button type="button" className="theme-system" aria-label="Use system theme" aria-pressed={preference === 'system'} title="Follow your device’s light/dark preference" onClick={() => choose('system')}>Auto</button>
  </div>;
}
