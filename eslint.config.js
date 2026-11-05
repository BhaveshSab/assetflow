import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The lint rules of the frontend.
 *
 * The rules are the ones that catch real mistakes, not the ones that make
 * the code look a certain way:
 *
 *   • react-hooks — a missing or wrong dependency in useEffect is a bug
 *     that the type checker cannot see (a stale value, a request that runs
 *     twice),
 *   • react-refresh — a component that exports something else makes the
 *     fast refresh of the dev server stop working,
 *   • typescript-eslint — the rules that catch the mistakes TypeScript
 *     itself allows (unused values, floating promises, …),
 *   • js — the errors, not the formatting opinions.
 */
export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "coverage"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2021 },
      // The rules that need to know the types (no-floating-promises) read
      // the TypeScript project of the repository.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The helpers that live next to their component on purpose: the test
      // imports `initialsOf`, the buttons share their variants.
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: ["initialsOf", "buttonVariants", "badgeVariants"],
        },
      ],
      /*
       * The data-loading views set `loading` and then fetch inside an effect.
       * React's newer guidance prefers a data library (TanStack Query) or a
       * `use()` boundary; until that refactor the pattern is correct but not
       * ideal, so it is reported as a warning rather than hidden — or than
       * rewritten blind across thirteen screens.
       */
      "react-hooks/set-state-in-effect": "warn",
      // The design tokens of the project are CSS variables in useTheme().
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // A promise that nobody waits for is usually a forgotten error path.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // The tests may use `any` for the props of a mock.
    files: ["**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
