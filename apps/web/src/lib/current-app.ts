import { useSyncExternalStore } from 'react';

/** The application selected in the top-bar switcher, remembered per browser. */
const KEY = 'stepforge.currentApp';
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let current = read();

/** The selected application id outside React. */
export const getCurrentAppId = (): string | null => current;

export function setCurrentAppId(id: string | null): void {
  current = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function useCurrentAppId(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => current,
  );
}
