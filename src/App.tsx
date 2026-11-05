import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { ErrorBoundary } from "@/components/ui/error-boundary";
import AuthLayout from "@/pages/AuthLayout";
import AuthPage from "@/pages/AuthPage";
import Dashboard from "@/pages/Dashboard";

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

          <Route path="/Dashboard" element={<Dashboard />} />

          {/* Defaults */}
          <Route path="/" element={<Navigate to="/signin" replace />} />
          <Route path="*" element={<Navigate to="/signin" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
