export type Theme = "light" | "dark";
type ThemePreference = Theme | "system";

const storageKey = "waffle.web.theme";
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let theme: Theme = "light";
let system: MediaQueryList;

function applyTheme() {
  theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}

export function initializeTheme() {
  system = window.matchMedia("(prefers-color-scheme: dark)");
  preference = "system";
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") preference = saved;
  } catch {
    // Use the device theme when storage is unavailable.
  }
  applyTheme();
  system.addEventListener("change", applyTheme);
}

export function getTheme(): Theme {
  return theme;
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toggleTheme() {
  preference = theme === "dark" ? "light" : "dark";
  applyTheme();
  try {
    localStorage.setItem(storageKey, preference);
  } catch {
    /* Keep the selection active for this visit if it cannot be saved. */
  }
}
