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
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          charts: ["recharts"],
          motion: ["framer-motion"],
          icons: ["lucide-react"],
        },
      },
    },
    // The limit is a budget, not a rule of law: it makes a growing bundle
    // visible in the build output instead of being discovered in production.
    chunkSizeWarningLimit: 400,
  },
})
