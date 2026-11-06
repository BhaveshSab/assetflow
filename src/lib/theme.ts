/**
 * The theme — one place that decides light or dark, and one place that applies
 * it.
 *
 * The colours themselves live in `src/index.css` as CSS variables (`:root` is
 * the light theme, `.dark` is the dark one) and the components only ever use
 * token classes (`bg-surface`, `text-ink-muted`, …), so switching the theme is
 * a single class on the <html> element — no component re-renders and no
 * `dark:` variant in any of the ~2,000 class strings.
 *
 * Three sources of truth, in order:
 *
 *   1. what the user picked here (`localStorage["assetflow-theme"]`) — wins;
 *   2. otherwise the operating system's `prefers-color-scheme`;
 *   3. otherwise light.
 *
 * `index.html` repeats the resolution in a few lines of inline script before
 * the bundle loads, so a dark-mode user never sees a white flash. If this file
 * and that script ever disagree, the script runs first and this one corrects
 * it on mount — which is why the storage key is a constant here and a string
 * literal there, and the test asserts they match.
 */

export type Theme = "light" | "dark";

/** The key the choice is saved under — also read by the inline script. */
export const THEME_KEY = "assetflow-theme";

/** The class the dark theme hangs off, in `index.css` and in Tailwind. */
export const DARK_CLASS = "dark";

/** The stored preference, or `null` when the visitor has never picked one. */
export function readStoredTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    // Storage can be blocked (Safari private mode, a strict cookie policy).
    // A theme is not worth an exception: fall back to the system.
    return null;
  }
}

/** What the operating system is set to, defaulting to light. */
export function systemTheme(): Theme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

/** The theme to show on load: the saved choice, else the system's. */
export function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? systemTheme();
}

/**
 * Paint a theme.
 *
 * Done by hand rather than with a React state-driven className because the
 * class has to be right for the *document*, not for a component subtree: the
 * <body> background, the scrollbar and the browser's own form controls all
 * read it.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, theme === "dark");
  // Tells the browser how to paint the scrollbar, the caret and the default
  // form controls — without it a dark page gets a white scrollbar track.
  root.style.colorScheme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#0f111a" : "#f6f7fb";
}

/** Remember the choice. Never throws — a blocked store just means "for now". */
export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the theme still applies for this visit */
  }
}

/** The other theme. */
export function oppositeTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}
