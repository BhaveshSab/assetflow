/**
 * The theme resolver: which theme is shown, and where it is remembered.
 *
 * These are the rules the inline script in `index.html` repeats, so they are
 * worth pinning down — if one of them changes, the page flashes the wrong
 * colour for a frame on every load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DARK_CLASS,
  THEME_KEY,
  applyTheme,
  oppositeTheme,
  readStoredTheme,
  resolveInitialTheme,
  storeTheme,
  systemTheme,
} from "./theme";

/** Pretend the operating system prefers `theme`. */
function setSystemTheme(theme: "light" | "dark") {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: theme === "dark" && query.includes("dark"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

describe("theme", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
  });

  it("reads back only a value it understands", () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");

    window.localStorage.setItem(THEME_KEY, "solar-flare");
    expect(readStoredTheme()).toBeNull();

    window.localStorage.clear();
    expect(readStoredTheme()).toBeNull();
  });

  it("survives a storage that throws", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    expect(readStoredTheme()).toBeNull();
    expect(() => storeTheme("dark")).not.toThrow();
    getItem.mockRestore();
  });

  it("follows the operating system when nothing has been chosen", () => {
    setSystemTheme("dark");
    expect(systemTheme()).toBe("dark");
    expect(resolveInitialTheme()).toBe("dark");

    setSystemTheme("light");
    expect(resolveInitialTheme()).toBe("light");
  });

  it("lets an explicit choice outrank the operating system", () => {
    setSystemTheme("dark");
    storeTheme("light");

    expect(resolveInitialTheme()).toBe("light");
  });

  it("applies the class and the browser hint together", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("keeps the address-bar colour in step with the theme", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);

    applyTheme("dark");
    expect(meta.content).toBe("#0f111a");
    applyTheme("light");
    expect(meta.content).toBe("#f6f7fb");

    meta.remove();
  });

  it("has exactly two themes, and a switch between them", () => {
    expect(oppositeTheme("light")).toBe("dark");
    expect(oppositeTheme("dark")).toBe("light");
  });

  it("uses the storage key the inline script in index.html looks for", () => {
    // index.html is not imported by the bundle, so the agreement is asserted
    // here instead of being a comment nobody checks.
    expect(THEME_KEY).toBe("assetflow-theme");
    expect(DARK_CLASS).toBe("dark");
  });
});
