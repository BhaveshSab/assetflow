import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

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
          if (
            /node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)
          ) {
            return "react";
          }
          return "vendor";
        },
      },
    },
    // The limit is a budget, not a rule of law: it makes a growing bundle
    // visible in the build output instead of being discovered in production.
    chunkSizeWarningLimit: 400,
  },
})
