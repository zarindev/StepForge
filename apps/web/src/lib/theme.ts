import type { Settings } from './api';

const STORAGE_KEY = 'stepforge.theme';

export function applyTheme(theme: Settings['theme']): void {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

/** Applies the last-used theme synchronously to avoid a flash before settings load. */
export function applyCachedTheme(): void {
  try {
    const cached = localStorage.getItem(STORAGE_KEY) as Settings['theme'] | null;
    if (cached) applyTheme(cached);
  } catch {
    /* storage unavailable */
  }
}
