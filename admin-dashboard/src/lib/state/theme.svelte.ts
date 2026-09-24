export const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'contrast', label: 'High Contrast' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

export const THEME_STORAGE_KEY = 'slinger.theme';

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

export function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

class ThemeState {
  current = $state<ThemeId>('system');

  init() {
    this.current = readStoredTheme();
    this.apply();
  }

  set(id: ThemeId) {
    this.current = id;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* storage unavailable: theme still applies for this page load */
    }
    this.apply();
  }

  private apply() {
    document.documentElement.setAttribute('data-theme', this.current);
  }
}

export const theme = new ThemeState();
