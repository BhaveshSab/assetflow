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
/*
 * The account screens are lazy too: someone who is signing in should not
 * download the profile form, and vice versa.
 */
const ProfilePage = lazy(() => import("@/pages/ProfilePage"));
/*
 * The reset flow is two more screens that the sign-in page does not need:
 * only a visitor who forgot their password ever loads them.
 */
const ForgotPasswordPage = lazy(() => import("@/pages/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("@/pages/ResetPasswordPage"));

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="min-h-screen bg-canvas flex items-center justify-center gap-2 text-ink-muted text-sm"
    >
      <Loader2 size={18} className="animate-spin text-info" aria-hidden="true" />
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
            {/* The two halves of the reset flow. They live in the auth layout
                (same background, same theme switch) because they are visited
                by someone who is *not* signed in. */}
            <Route
              path="/forgot-password"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <ForgotPasswordPage />
                </Suspense>
              }
            />
            <Route
              path="/reset-password"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <ResetPasswordPage />
                </Suspense>
              }
            />
          </Route>

          {/* The account page needs a session, like the dashboard. */}
          <Route
            path="/profile"
            element={
              <Suspense fallback={<RouteFallback />}>
                <ProfilePage />
              </Suspense>
            }
          />

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
