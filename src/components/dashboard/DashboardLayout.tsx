import { motion } from "framer-motion";

import Sidebar, { type SidebarProps } from "@/components/dashboard/Sidebar";
import TopHeader from "@/components/dashboard/TopHeader";

export type ViewName =
  | "Dashboard"
  | "AssetDirectory"
  | "AllocationsTransfers"
  | "ResourceBooking"
  | "Maintenance"
  | "AssetAudits"
  | "ReportsAnalytics"
  | "OrganizationSetup"
  | "ActivityLogs"
  | "MyAssets";

export interface DashboardLayoutProps {
  children: React.ReactNode;
  className?: string;
  /** Currently active view (drives content transition key). */
  currentView?: ViewName;
  /** Props forwarded to the RBAC Sidebar. */
  sidebarProps: SidebarProps;
}

/**
 * Dark-mode dashboard shell: RBAC Sidebar + TopHeader + scrollable content.
 *
 * The Sidebar manages its own mobile drawer, collapse, and sign-out confirm.
 */
export default function DashboardLayout({
  children,
  className,
  currentView = "Dashboard",
  sidebarProps,
}: DashboardLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      {/* ── RBAC Sidebar (self-managed mobile/collapse) ────── */}
      <Sidebar {...sidebarProps} />

      {/* ── Main area ─────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopHeader />

        <main className={`flex-1 overflow-y-auto p-4 sm:p-6 ${className ?? ""}`}>
          <motion.div
            key={currentView}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: "spring" as const, stiffness: 350, damping: 30 }}
          >
            {children}
          </motion.div>
        </main>
      </div>
    </div>
  );
}
