import { useCallback, useEffect, useState } from "react";

import {
  applyTheme,
  oppositeTheme,
  readStoredTheme,
  resolveInitialTheme,
  storeTheme,
  systemTheme,
  type Theme,
} from "@/lib/theme";

export interface ThemeControls {
  /** The theme currently on the document. */
  theme: Theme;
  /** Switch to a specific theme and remember it. */
  setTheme: (theme: Theme) => void;
  /** Flip light <-> dark and remember it. */
  toggleTheme: () => void;
  /**
   * `true` when the theme came from the operating system rather than from the
   * visitor — the header says so, which makes "why is it dark?" answerable.
   */
  followsSystem: boolean;
}

/**
 * Keeps the document theme and a React component in step.
 *
 * The pixels are owned by the class on <html> (see `src/lib/theme.ts`); this
 * hook exists so the header can show which way the switch is pointing. The
 * system listener is only attached while no explicit choice has been stored —
 * once someone picks a theme, their choice outranks the OS.
 */
export function useTheme(): ThemeControls {
  const [theme, setThemeState] = useState<Theme>(() => resolveInitialTheme());
  const [followsSystem, setFollowsSystem] = useState<boolean>(
    () => readStoredTheme() === null,
  );

  /*
   * The pixels follow the state — never the other way round.
   *
   * The initial value already ran the same resolution as the inline script in
   * index.html (saved choice, then the system), so on mount this simply
   * re-asserts the class: it costs one `classList.toggle` and it repairs the
   * page if the inline script was skipped (a strict CSP, a blocked store).
   */
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS while the visitor has not chosen.
  useEffect(() => {
    if (!followsSystem) return;
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query?.addEventListener) return;

    const onChange = () => {
      setThemeState(systemTheme());
    };

    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [followsSystem]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    setFollowsSystem(false);
    applyTheme(next);
    storeTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(oppositeTheme(theme));
  }, [setTheme, theme]);

  return { theme, setTheme, toggleTheme, followsSystem };
}
