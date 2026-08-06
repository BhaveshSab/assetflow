import { useEffect, useState, useCallback } from "react";
import { Navigate } from "react-router-dom";

import DashboardLayout, { type ViewName } from "@/components/dashboard/DashboardLayout";
import type { Role, SidebarProps } from "@/components/dashboard/Sidebar";
import AdminDashboard from "@/components/dashboard/AdminDashboard";
import ManagerDashboard from "@/components/dashboard/ManagerDashboard";
import EmployeeDashboard from "@/components/dashboard/EmployeeDashboard";
import AssetDirectory from "@/components/dashboard/AssetDirectory";
import AllocationsTransfers from "@/components/dashboard/AllocationsTransfers";
import ResourceBooking from "@/components/dashboard/ResourceBooking";
import Maintenance from "@/components/dashboard/Maintenance";
import AssetAudits from "@/components/dashboard/AssetAudits";
import ReportsAnalytics from "@/components/dashboard/ReportsAnalytics";
import OrganizationSetup from "@/components/dashboard/OrganizationSetup";
import ActivityLogs from "@/components/dashboard/ActivityLogs";
import MyAssets from "@/components/dashboard/MyAssets";
import { apiGet } from "@/lib/api";
import { clearSession, getMe, getSession, type AuthResponse } from "@/lib/auth";

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
      const kpi = await apiGet<DashboardKpi>("/reports/dashboard");
      setBadges({
        pendingTransfers: kpi.pendingTransfers ?? 0,
        maintenanceRequests: kpi.maintenanceToday ?? 0,
        overdueReturns: kpi.overdueReturns ?? 0,
        notifications: kpi.overdueReturns ?? 0,
      });
    } catch {
      /* backend unreachable — keep last known badges */
    }
  }, []);

  useEffect(() => {
    refreshBadges();
    const t = setInterval(refreshBadges, 60_000);
    return () => clearInterval(t);
  }, [refreshBadges]);

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

  /** Sidebar nav + quick-action strings → ViewName */
  const handleNavigate = (pageId: string) => {
    const view = NAVIGATE_MAP[pageId];
    if (!view) return;
    if (role === "EMPLOYEE" && MANAGER_ONLY_VIEWS.includes(view)) {
      // Redirect employees to their own assets instead of a 403 manager page.
      setActivePage("my-assets");
      setCurrentView("MyAssets");
      return;
    }
    setActivePage(pageId);
    setCurrentView(view);
  };

  /** Build sidebar props from session */
  const role: Role = session.user.role ?? "EMPLOYEE";
  const sidebarProps: SidebarProps = {
    user: {
      name: session.user.name,
      email: session.user.email,
      role,
    },
    onSignOut: handleSignOut,
    activePage,
    onNavigate: handleNavigate,
    badges,
  };

  const isManager = role === "ADMIN" || role === "ASSET_MANAGER";
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
    </DashboardLayout>
  );
}
