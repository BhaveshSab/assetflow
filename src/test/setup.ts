/**
 * Vitest setup — a minimal localStorage for jsdom.
 *
 * jsdom ships a localStorage, but it is per test file; clearing it between
 * tests keeps the session helpers isolated.
 */
import { afterEach, beforeEach } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});
