import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { ErrorBoundary } from "@/components/ui/error-boundary";
import AuthLayout from "@/pages/AuthLayout";
import AuthPage from "@/pages/AuthPage";

/*
 * The dashboard is a separate file: a visitor who only opens the sign-in
 * page does not download the charts, the tables and the eight views behind
 * it.
 */
const Dashboard = lazy(() => import("@/pages/Dashboard"));

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="min-h-screen bg-zinc-950 flex items-center justify-center gap-2 text-zinc-400 text-sm"
    >
      <Loader2 size={18} className="animate-spin text-blue-400" aria-hidden="true" />
      Loading AssetFlow…
    </div>
  );
}

export default function App() {
  return (
    // A rendering error in one view must not leave the user with a blank
    // page — the boundary keeps the app alive and offers a way out.
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/signin" element={<AuthPage mode="signin" />} />
            <Route path="/signup" element={<AuthPage mode="signup" />} />
          </Route>

          <Route
            path="/Dashboard"
            element={
              <Suspense fallback={<RouteFallback />}>
                <Dashboard />
              </Suspense>
            }
          />

          {/* Defaults */}
          <Route path="/" element={<Navigate to="/signin" replace />} />
          <Route path="*" element={<Navigate to="/signin" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
