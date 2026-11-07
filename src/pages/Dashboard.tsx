import { lazy, Suspense, useEffect, useState, useCallback } from "react";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import DashboardLayout, { type ViewName } from "@/components/dashboard/DashboardLayout";
import type { Role, SidebarProps } from "@/components/dashboard/Sidebar";
import { apiGet } from "@/lib/api";

/*
 * The views are loaded when they are first opened.
 *
 * The whole application used to arrive in one file, so a user who only
 * wanted to book a room also downloaded the charts of the analytics page.
 * Now only the sign-in page and the shell are loaded up front; every view
 * arrives when it is opened — and the browser keeps it in its cache for the
 * next time.
 */
const AdminDashboard = lazy(() => import("@/components/dashboard/AdminDashboard"));
const ManagerDashboard = lazy(() => import("@/components/dashboard/ManagerDashboard"));
const EmployeeDashboard = lazy(() => import("@/components/dashboard/EmployeeDashboard"));
const AssetDirectory = lazy(() => import("@/components/dashboard/AssetDirectory"));
const AllocationsTransfers = lazy(
  () => import("@/components/dashboard/AllocationsTransfers"),
);
const ResourceBooking = lazy(() => import("@/components/dashboard/ResourceBooking"));
const Maintenance = lazy(() => import("@/components/dashboard/Maintenance"));
const AssetAudits = lazy(() => import("@/components/dashboard/AssetAudits"));
const ReportsAnalytics = lazy(() => import("@/components/dashboard/ReportsAnalytics"));
const OrganizationSetup = lazy(() => import("@/components/dashboard/OrganizationSetup"));
const ActivityLogs = lazy(() => import("@/components/dashboard/ActivityLogs"));
const MyAssets = lazy(() => import("@/components/dashboard/MyAssets"));

/** Shown while a view is being downloaded — it is announced, not just seen. */
function ViewFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center py-20 gap-2 text-ink-subtle text-sm"
    >
      <Loader2 size={18} className="animate-spin text-info" aria-hidden="true" />
      Loading…
    </div>
  );
}
import { clearSession, getMe, getSession, type AuthResponse } from "@/lib/auth";
import { usePolling } from "@/hooks/usePolling";

/* ------------------------------------------------------------------ */
/*  Role + KPI badges come from the real backend (JWT + /reports).     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Navigation mapping — sidebar pageIds + quick-action strings       */
/* ------------------------------------------------------------------ */
const NAVIGATE_MAP: Record<string, ViewName> = {
  // Sidebar pageIds
  dashboard: "Dashboard",
  "asset-directory": "AssetDirectory",
  allocations: "AllocationsTransfers",
  booking: "ResourceBooking",
  maintenance: "Maintenance",
  audits: "AssetAudits",
  reports: "ReportsAnalytics",
  organization: "OrganizationSetup",
  activity: "ActivityLogs",
  // Quick-action strings from dashboards
  transfers: "AllocationsTransfers",
  register: "AssetDirectory",
  assets: "AssetDirectory",
  "my-assets": "MyAssets",
  "my-bookings": "ResourceBooking",
  "my-maintenance": "Maintenance",
};

interface DashboardKpi {
  pendingTransfers?: number;
  maintenanceToday?: number;
  overdueReturns?: number;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */
export default function Dashboard() {
  const [session, setSession] = useState<AuthResponse | null>(getSession());
  const [currentView, setCurrentView] = useState<ViewName>("Dashboard");
  const [activePage, setActivePage] = useState("dashboard");
  const [badges, setBadges] = useState({
    pendingTransfers: 0,
    maintenanceRequests: 0,
    overdueReturns: 0,
    notifications: 0,
  });

  // Refresh role from the backend JWT on mount.
  useEffect(() => {
    getMe()
      .then((user) => {
        const s = getSession();
        if (s) setSession({ ...s, user });
      })
      .catch(() => {
        clearSession();
        setSession(null);
      });
  }, []);

  // Live KPI badges for the sidebar (every 60s).
  const refreshBadges = useCallback(async () => {
    try {
      const [kpi, notifications] = await Promise.all([
        apiGet<DashboardKpi>("/reports/dashboard"),
        apiGet<{ unreadCount?: number }>("/notifications"),
      ]);
      setBadges({
        pendingTransfers: kpi.pendingTransfers ?? 0,
        maintenanceRequests: kpi.maintenanceToday ?? 0,
        overdueReturns: kpi.overdueReturns ?? 0,
        notifications: notifications.unreadCount ?? 0,
      });
    } catch {
      /* backend unreachable — keep last known badges */
    }
  }, []);

  // Refresh the badges every 60s — no overlapping requests, nothing while
  // the tab is hidden.
  usePolling(refreshBadges, 60_000);

  if (!session) return <Navigate to="/signin" replace />;

  const handleSignOut = () => {
    clearSession();
    setSession(null);
  };

  /** Views that employees must never reach (sidebar hides them, but quick-action
   *  strings could still resolve here — block them so the UI can't be bypassed). */
  const MANAGER_ONLY_VIEWS: ViewName[] = [
    "AssetDirectory",
    "AssetAudits",
    "ReportsAnalytics",
    "OrganizationSetup",
    "ActivityLogs",
  ];

  /** Views a department head's role cannot load (the API answers 403). The
   *  sidebar hides them; quick actions and the activity bell must not resolve
   *  them either. */
  const HEAD_DENIED_VIEWS: ViewName[] = [
    "AssetAudits",
    "ReportsAnalytics",
    "OrganizationSetup",
    "ActivityLogs",
  ];

  /** Build sidebar props from session */
  const role: Role = session.user.role ?? "EMPLOYEE";

  /** Sidebar nav + quick-action strings → ViewName */
  const handleNavigate = (pageId: string) => {
    const view = NAVIGATE_MAP[pageId];
    if (!view) return;
    if (role === "DEPARTMENT_HEAD" && HEAD_DENIED_VIEWS.includes(view)) return;
    if (role === "EMPLOYEE" && MANAGER_ONLY_VIEWS.includes(view)) {
      // Redirect employees to their own assets instead of a 403 manager page.
      setActivePage("my-assets");
      setCurrentView("MyAssets");
      return;
    }
    setActivePage(pageId);
    setCurrentView(view);
  };

  const sidebarProps: SidebarProps = {
    user: {
      name: session.user.name,
      email: session.user.email,
      role,
      // Set on /profile; the header and the sidebar both show it.
      avatar: session.user.avatarUrl ?? undefined,
    },
    onSignOut: handleSignOut,
    activePage,
    onNavigate: handleNavigate,
    badges,
  };

  // Department heads get the manager view: its KPIs, transfers and maintenance
  // queue are scoped for them, while the organisation-wide charts are not.
  const isManager =
    role === "ADMIN" ||
    role === "ASSET_MANAGER" ||
    role === "DEPARTMENT_HEAD";
  const maintenanceRole: "ADMIN" | "ASSET_MANAGER" | "EMPLOYEE" =
    role === "ADMIN"
      ? "ADMIN"
      : role === "ASSET_MANAGER"
        ? "ASSET_MANAGER"
        : "EMPLOYEE";

  return (
    <DashboardLayout
      currentView={currentView}
      sidebarProps={sidebarProps}
    >
      <Suspense fallback={<ViewFallback />}>
      {currentView === "Dashboard" && (
        role === "ADMIN"
          ? <AdminDashboard onNavigate={handleNavigate} onSignOut={handleSignOut} />
          : isManager
            ? <ManagerDashboard onNavigate={handleNavigate} onSignOut={handleSignOut} />
            : <EmployeeDashboard onNavigate={handleNavigate} onSignOut={handleSignOut} />
      )}

      {currentView === "AssetDirectory" && <AssetDirectory />}
      {currentView === "AllocationsTransfers" && (
        <AllocationsTransfers
          userRole={role}
          currentUserId={session.user.id}
          currentUserName={session.user.name}
        />
      )}
      {currentView === "ResourceBooking" && <ResourceBooking />}
      {currentView === "Maintenance" && (
        <Maintenance
          userRole={maintenanceRole}
          currentUser={session.user.name}
          currentUserId={session.user.id}
        />
      )}
      {currentView === "AssetAudits" && <AssetAudits />}
      {currentView === "ReportsAnalytics" && <ReportsAnalytics />}
      {currentView === "OrganizationSetup" && <OrganizationSetup />}
      {currentView === "ActivityLogs" && <ActivityLogs />}
      {currentView === "MyAssets" && <MyAssets onNavigate={handleNavigate} />}
      </Suspense>
    </DashboardLayout>
  );
}
