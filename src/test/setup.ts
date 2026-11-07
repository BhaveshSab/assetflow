/**
 * Vitest setup — jsdom + a clean localStorage per test.
 *
 * jsdom ships a localStorage, but it is shared per test file; clearing it
 * between tests keeps the session helpers isolated.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

/**
 * The session helpers read the bare `localStorage` global. Neither jsdom here
 * nor plain Node provides one by default, and the file-backed store Node can
 * be given with `--localstorage-file` is shared by every test file in the run —
 * that made the session tests depend on the flag and on each other. A fresh
 * in-memory store per test file keeps them self-contained.
 */
function createMemoryStorage(): Storage {
  let entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries = new Map();
    },
    getItem(key: string) {
      return entries.has(key) ? entries.get(key)! : null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value));
    },
  };
}

const storage = createMemoryStorage();
for (const target of new Set<object>([globalThis, window])) {
  Object.defineProperty(target, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  cleanup();
});
