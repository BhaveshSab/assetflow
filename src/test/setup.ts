/**
 * Vitest setup — jsdom + a clean localStorage per test.
 *
 * jsdom ships a localStorage, but it is shared per test file; clearing it
 * between tests keeps the session helpers isolated.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  cleanup();
});
