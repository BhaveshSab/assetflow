import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The dev server is reachable from the browser sandbox that hosts the
    // preview, so that host has to be allowed explicitly (Vite refuses an
    // unknown Host header — a DNS-rebinding guard).
    host: true,
    allowedHosts: [".e2b.app", ".vercel.app", "localhost"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    /*
     * The whole application used to arrive in one 1.1 MB file, so the first
     * paint waited for the charting library, the animation library and every
     * view. The heavy libraries now have their own files, which the browser
     * can cache on their own, and the views are loaded on demand
     * (React.lazy in App.tsx).
     */
    rollupOptions: {
      output: {
        /*
         * Chunks are assigned by path, not by package name.
         *
         * The package form (`charts: ["recharts"]`) looks precise but is not:
         * Rollup put recharts' *dependencies* — `clsx`, which the shell's
         * `cn()` helper needs — into the charts chunk too. The entry then had
         * a static import of the charts chunk, so Vite emitted
         * `<link rel="modulepreload">` for all 412 kB of Recharts and the
         * "charts load on demand" claim was quietly false: they loaded on
         * every first paint. Assigning by module path keeps the charting
         * library in a file that only a lazily-imported view asks for.
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("html5-qrcode")) return "qr-scanner";
          if (id.includes("/qrcode/") || id.includes("/dijkstrajs/"))
            return "qr-labels";
          if (
            id.includes("recharts") ||
            id.includes("d3-") ||
            id.includes("victory-vendor") ||
            id.includes("react-smooth") ||
            id.includes("decimal.js-light")
          ) {
            return "charts";
          }
          /*
           * Radix is only reachable from the lazily-loaded views (the dialog
           * and the switch), so it gets its own file: whatever sits in the
           * shared `vendor` chunk is downloaded with the sign-in page, and
           * the sign-in page has no dialog on it.
           */
          if (id.includes("@radix-ui")) return "ui";
          // Framer Motion 12 ships its engine in `motion-dom`/`motion-utils`;
          // matching only the package name leaves ~90 kB of it in `vendor`.
          if (
            id.includes("framer-motion") ||
            id.includes("motion-dom") ||
            id.includes("motion-utils")
          ) {
            return "motion";
          }
          if (id.includes("lucide-react")) return "icons";
          /*
           * React, ReactDOM, React Router and the React-adjacent CommonJS
           * packages share ONE file — deliberately.
           *
           * They used to get a `react` chunk of their own, and that created a
           * circular import between two files:
           *
           *   react-*.js   imports Rollup's CJS-interop helpers from vendor
           *   vendor-*.js  imports the React namespace back from react
           *
           * A circular pair only works while the browser happens to evaluate
           * them in the lucky order. `use-sync-external-store` (pulled in by
           * Framer Motion) copies `React.useState` into a variable *while its
           * module body runs*, so when `react` was evaluated first, `vendor`
           * read it as `undefined` and the page died before painting:
           *
           *   TypeError: Cannot read properties of undefined (reading 'useState')
           *
           * Build 2026-11-07 shipped exactly that: `npm test` and `npm run
           * build` were both green, and the site was a blank page. One chunk
           * cannot be circular with itself, so this is the structural fix,
           * not a reordering trick. The first load is the same bytes: both
           * files were preloaded on every page (147.4 kB gz before, 146.5 kB
           * after — one chunk header less).
           *
           * `scripts/bundle-smoke.mjs` fails the build if a chunk cycle ever
           * comes back, and it is the only check here that loads the real
           * bundle in a DOM.
           */
          return "vendor";
        },
      },
    },
    // The limit is a budget, not a rule of law: it makes a growing bundle
    // visible in the build output instead of being discovered in production.
    chunkSizeWarningLimit: 400,
  },
});
