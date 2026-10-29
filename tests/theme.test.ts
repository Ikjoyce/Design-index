import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readThemePreference, resolveTheme, THEME_COLORS, THEME_STORAGE_KEY } from '../apps/web/src/theme.js';

describe('theme preference', () => {
  it.each(['light', 'dark'] as const)('recognizes a saved %s override', (theme) => {
    expect(readThemePreference(() => theme)).toBe(theme);
    expect(resolveTheme(theme, true)).toBe(theme);
    expect(resolveTheme(theme, false)).toBe(theme);
  });

  it.each([null, '', 'system', 'unexpected'])('uses system appearance for %s', (value) => {
    const preference = readThemePreference(() => value);
    expect(preference).toBe('system');
    expect(resolveTheme(preference, true)).toBe('dark');
    expect(resolveTheme(preference, false)).toBe('light');
  });

  it('works when browser storage is unavailable', () => {
    expect(readThemePreference(() => { throw new Error('Storage blocked.'); })).toBe('system');
  });

  it('keeps the pre-render bootstrap contract aligned with the runtime theme code', () => {
    const script = readFileSync(new URL('../apps/web/public/theme.js', import.meta.url), 'utf8');
    expect(script).toContain(THEME_STORAGE_KEY);
    for (const color of Object.values(THEME_COLORS)) expect(script).toContain(color);
  });
});

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

it.each(['light', 'dark'] as const)('maintains readable semantic text pairs in %s mode', (theme) => {
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  const root = css.match(/:root \{([^}]+)\}/)![1]!;
  const overrides = theme === 'dark' ? css.match(/:root\[data-theme="dark"\] \{([^}]+)\}/)![1]! : '';
  const tokens = Object.fromEntries([...`${root}${overrides}`.matchAll(/(--[\w-]+):\s*(#[\da-fA-F]{6});/g)].map((match) => [match[1]!, match[2]!]));
  const pairs = [
    ['--ink', '--page'], ['--ink', '--surface'], ['--ink', '--sidebar'],
    ['--muted', '--surface-accent'], ['--muted', '--surface-raised'],
    ['--badge-ink', '--badge'], ['--on-primary', '--green'], ['--on-primary', '--primary-hover'],
    ['--error-ink', '--error-bg'], ['--warning-ink', '--warning-bg'], ['--placeholder', '--surface-input'],
  ];
  for (const [foreground, background] of pairs) {
    const values = [luminance(tokens[foreground!]!), luminance(tokens[background!]!)].sort((a, b) => b - a);
    expect((values[0]! + 0.05) / (values[1]! + 0.05), `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
});
