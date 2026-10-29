// Run before the page renders. Keep storage key/colors aligned with src/theme.ts.
// External script: compatible with the app's script-src 'self' policy; no inline script needed.
(() => {
  let preference = 'system';
  try {
    const saved = localStorage.getItem('design-index-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* Storage can be unavailable in private/restricted browser contexts. */ }
  const systemIsDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = preference === 'system' ? (systemIsDark ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121814' : '#f5f4ef');
})();
