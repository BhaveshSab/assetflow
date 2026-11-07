import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Package, CalendarCheck, Wrench, AlertTriangle, Clock, CheckCircle2,
  Boxes, Settings, Activity, Bell, Zap, ChevronRight, X,
  RefreshCw, Plus,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getSession, type AuthResponse } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import RegisterAssetModal from "@/components/dashboard/RegisterAssetModal";
import { usePolling } from "@/hooks/usePolling";
import { type LucideIcon } from "lucide-react";
import { type ChartTooltipProps } from "@/types/chart";

// =============================================
// TYPES
// =============================================
interface KPIData {
  assetsAvailable: number;
  assetsAllocated: number;
  maintenanceToday: number;
  activeBookings: number;
  upcomingReturns: number;
  overdueReturns: number;
  kpiTrends: Record<string, string>;
}

interface ChartPoint {
  date: string;
  allocated: number;
  available: number;
}

interface ActivityItem {
  id: number;
  type: string;
  text: string;
  time: string;
  status: "success" | "danger" | "warning" | "info";
}

interface OverdueAsset {
  id: number;
  assetTag: string;
  assetName: string;
  employee: string;
  daysOverdue: number;
  dept: string;
}

interface AdminDashboardProps {
  onNavigate: (screen: string) => void;
  onSignOut: () => void;
}

// =============================================
// API SERVICE (real backend — no fake data; failures surface as errors)
// =============================================
const timeAgo = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const statusForAction = (action: string): ActivityItem["status"] => {
  if (action.includes("overdue") || action.includes("reject")) return "danger";
  if (action.includes("maintenance") || action.includes("transfer")) return "warning";
  if (action.includes("booking")) return "info";
  return "success";
};

const prettyAction = (action: string) =>
  action.replace(/\./g, " ").replace(/(^|\s)\w/g, (m) => m.toUpperCase());

const apiService = {
  getKPIs: async (): Promise<KPIData> => {
    const d = await apiGet<Record<string, number>>("/reports/dashboard");
    return {
      assetsAvailable: d.assetsAvailable ?? 0,
      assetsAllocated: d.assetsAllocated ?? 0,
      maintenanceToday: d.maintenanceToday ?? 0,
      activeBookings: d.activeBookings ?? 0,
      upcomingReturns: d.upcomingReturns ?? 0,
      overdueReturns: d.overdueReturns ?? 0,
      kpiTrends: {
        assetsAvailable: `${d.assetsAvailable ?? 0} ready to assign`,
        assetsAllocated: `${d.assetsAllocated ?? 0} in use`,
        maintenanceToday: `${d.assetsUnderMaintenance ?? 0} under maintenance`,
        activeBookings: `${d.activeBookings ?? 0} right now`,
        upcomingReturns: "Next 7 days",
        overdueReturns: "Needs immediate action",
      },
    };
  },
  getChartData: async (): Promise<ChartPoint[]> => {
    const data = await apiGet<ChartPoint[]>("/reports/asset-activity");
    return Array.isArray(data) ? data : [];
  },
  getRecentActivity: async (): Promise<ActivityItem[]> => {
    const data = await apiGet<{ items: Array<{
      id: string; action: string; entityType: string | null; entityId: string | null;
      actor?: { name: string } | null; createdAt: string;
    }> }>("/activity?take=12");
    return data.items.map((a, i) => ({
      id: i + 1,
      type: (a.entityType ?? "activity").toLowerCase(),
      text: `${a.actor?.name ?? "System"} ${prettyAction(a.action)}`,
      time: timeAgo(a.createdAt),
      status: statusForAction(a.action),
    }));
  },
  getOverdueAssets: async (): Promise<OverdueAsset[]> => {
    const d = await apiGet<{ overdueList?: Array<{
      id: string; expectedReturnDate: string;
      asset?: { assetTag: string; name: string };
      holderUser?: { name: string; departmentId?: string | null };
      department?: { name: string } | null;
    }> }>("/reports/dashboard");
    const list = d.overdueList ?? [];
    return list.map((o, i) => ({
      id: i + 1,
      assetTag: o.asset?.assetTag ?? "",
      assetName: o.asset?.name ?? "Asset",
      employee: o.holderUser?.name ?? o.department?.name ?? "—",
      daysOverdue: Math.max(1, Math.floor((Date.now() - new Date(o.expectedReturnDate).getTime()) / 86400000)),
      dept: o.holderUser?.departmentId ?? o.department?.name ?? "—",
    }));
  },
};

// =============================================
// HELPERS
// =============================================
const statusDot: Record<string, string> = {
  success: "bg-success", danger: "bg-danger",
  warning: "bg-warning", info: "bg-info",
};

const ChartTooltip = ({ active, payload, label }: ChartTooltipProps) => {
  if (active && payload?.length) {
    return (
      <div className="bg-surface-3 border border-[#333] rounded-xl p-3 shadow-xl text-xs">
        <p className="text-ink-muted mb-1">{label}</p>
        {payload.map((entry, i) => (
          <p key={i} style={{ color: entry.color }} className="font-semibold">{entry.name}: {entry.value}</p>
        ))}
      </div>
    );
  }
  return null;
};

// =============================================
// SUB-COMPONENTS
// =============================================
const KPICard = ({ title, value, trend, icon: Icon, color, iconBg, isOverdue = false, delay = 0 }: {
  title: string; value: number | undefined; trend: string; icon: LucideIcon; color: string; iconBg: string; isOverdue?: boolean; delay?: number;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
    transition={{ delay, duration: 0.4 }}
    className={`relative rounded-2xl p-5 border flex flex-col gap-3 overflow-hidden ${
      isOverdue ? "bg-danger/10 border-danger/40 shadow-[0_0_24px_rgba(239,68,68,0.15)]" : "bg-surface border-line"
    }`}
  >
    {isOverdue && (
      <div className="absolute top-2 right-2">
        <span className="flex items-center gap-1 bg-danger/20 text-danger text-[10px] font-bold px-2 py-0.5 rounded-full border border-danger/30">
          <AlertTriangle size={9} /> CRITICAL
        </span>
      </div>
    )}
    <div className="flex items-start justify-between">
      <div>
        <p className={`text-xs font-medium tracking-wide uppercase ${isOverdue ? "text-danger" : "text-ink-muted"}`}>{title}</p>
        <p className={`text-3xl font-bold mt-1 ${isOverdue ? "text-danger" : "text-ink"}`}>{value ?? "\u2014"}</p>
      </div>
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${iconBg}`}>
        <Icon size={20} className={color} />
      </div>
    </div>
    <p className={`text-[11px] ${isOverdue ? "text-danger/70" : "text-ink-subtle"}`}>{trend}</p>
  </motion.div>
);

const QuickAction = ({ icon: Icon, label, desc, color, bg, onClick, delay }: {
  icon: LucideIcon; label: string; desc: string; color: string; bg: string; onClick: () => void; delay: number;
}) => (
  <motion.button
    initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
    transition={{ delay, duration: 0.3 }}
    whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
    onClick={onClick}
    className={`w-full flex items-center gap-4 p-4 rounded-xl border border-line ${bg} hover:border-line transition-all text-left group`}
  >
    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color} flex-shrink-0`}><Icon size={18} /></div>
    <div className="flex-1 min-w-0">
      <p className="text-sm font-semibold text-ink">{label}</p>
      <p className="text-xs text-ink-subtle truncate">{desc}</p>
    </div>
    <ChevronRight size={16} className="text-ink-faint group-hover:text-ink-muted transition-colors" />
  </motion.button>
);

const NotificationPanel = ({
  activity,
  onClose,
  onViewAll,
}: {
  activity: ActivityItem[];
  onClose: () => void;
  onViewAll: () => void;
}) => (
  <motion.div
    initial={{ opacity: 0, y: -10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, y: -10, scale: 0.95 }}
    className="absolute top-14 right-0 w-80 bg-surface border border-line rounded-2xl shadow-2xl z-50 overflow-hidden"
  >
    <div className="flex items-center justify-between px-4 py-3 border-b border-line">
      <span className="text-sm font-semibold text-ink">Notifications</span>
      <button aria-label="Close" onClick={onClose}><X size={14} className="text-ink-muted hover:text-ink" /></button>
    </div>
    <div className="max-h-72 overflow-y-auto divide-y divide-line">
      {activity.slice(0, 6).map((a) => (
        <div key={a.id} className="px-4 py-3 hover:bg-surface-3 transition-colors">
          <div className="flex items-start gap-2">
            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${statusDot[a.status]}`} />
            <div>
              <p className="text-xs text-ink-soft leading-snug">{a.text}</p>
              <p className="text-[10px] text-ink-subtle mt-0.5">{a.time}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
    <div className="px-4 py-2 border-t border-line">
      <button
        type="button"
        onClick={onViewAll}
        className="text-xs text-info hover:text-info transition-colors"
      >
        View all notifications
      </button>
    </div>
  </motion.div>
);

// =============================================
// MAIN COMPONENT
// =============================================
export default function AdminDashboard({ onNavigate, onSignOut }: AdminDashboardProps) {
  const [session] = useState<AuthResponse | null>(getSession());
  const [kpi, setKpi] = useState<KPIData | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [overdue, setOverdue] = useState<OverdueAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [showNotif, setShowNotif] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [showRegister, setShowRegister] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Admin guard
  const isAdmin = session?.user?.role === "ADMIN";

  // Data fetcher — useCallback to avoid stale closures in setInterval
  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    setDataError(null);
    try {
      const [kpiData, chart, acts, ov] = await Promise.all([
        apiService.getKPIs(), apiService.getChartData(),
        apiService.getRecentActivity(), apiService.getOverdueAssets(),
      ]);
      setKpi(kpiData);
      setChartData(chart);
      setActivity(acts);
      setOverdue(ov);
      setLastUpdated(new Date());
    } catch (err) {
      setDataError(
        err instanceof Error
          ? err.message
          : "Failed to load dashboard data. Check that the backend is running.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Auto-refresh every 60s — no overlapping requests, nothing while the
  // tab is hidden.
  usePolling(fetchAll, 60_000, isAdmin);

  // ── Non-admin guard ──
  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-surface border border-danger/30 rounded-2xl p-8 text-center max-w-sm">
          <AlertTriangle size={40} className="text-danger mx-auto mb-3" />
          <p className="text-ink font-bold text-lg">Access Denied</p>
          <p className="text-ink-muted text-sm mt-1">This dashboard is restricted to Admins only.</p>
          <button onClick={onSignOut} className="mt-4 px-4 py-2 bg-danger/20 text-danger rounded-lg text-sm hover:bg-danger/30 transition-colors">
            Sign Out
          </button>
        </motion.div>
      </div>
    );
  }

  const username = session?.user?.name || session?.user?.email?.split("@")[0] || "Admin";

  const kpiCards = [
    { title: "Assets Available", value: kpi?.assetsAvailable, trend: kpi?.kpiTrends?.assetsAvailable ?? "\u2014", icon: Boxes, color: "text-success", iconBg: "bg-success/10", delay: 0.05 },
    { title: "Assets Allocated", value: kpi?.assetsAllocated, trend: kpi?.kpiTrends?.assetsAllocated ?? "\u2014", icon: Package, color: "text-info", iconBg: "bg-info/10", delay: 0.1 },
    { title: "Maintenance Today", value: kpi?.maintenanceToday, trend: kpi?.kpiTrends?.maintenanceToday ?? "\u2014", icon: Wrench, color: "text-warning", iconBg: "bg-warning/10", delay: 0.15 },
    { title: "Active Bookings", value: kpi?.activeBookings, trend: kpi?.kpiTrends?.activeBookings ?? "\u2014", icon: CalendarCheck, color: "text-violet", iconBg: "bg-violet/10", delay: 0.2 },
    { title: "Upcoming Returns", value: kpi?.upcomingReturns, trend: kpi?.kpiTrends?.upcomingReturns ?? "Next 7 days", icon: Clock, color: "text-cyan-400", iconBg: "bg-cyan-400/10", delay: 0.25 },
    { title: "Overdue Returns", value: kpi?.overdueReturns, trend: kpi?.kpiTrends?.overdueReturns ?? "Needs immediate action", icon: AlertTriangle, color: "text-danger", iconBg: "bg-danger/10", isOverdue: true, delay: 0.3 },
  ];

  const quickActions = [
    { icon: Plus, label: "Register Asset", desc: "Add a new asset to the inventory", color: "bg-success/20 text-success", bg: "bg-surface hover:bg-surface-3", onClick: () => setShowRegister(true), delay: 0.05 },
    { icon: Settings, label: "System Setup / Employee Directory", desc: "Manage departments, categories & promote roles", color: "bg-info/20 text-info", bg: "bg-surface hover:bg-surface-3", onClick: () => onNavigate("organization"), delay: 0.1 },
    { icon: CalendarCheck, label: "Book a Resource", desc: "Reserve conference rooms, vehicles & equipment", color: "bg-violet/20 text-violet", bg: "bg-surface hover:bg-surface-3", onClick: () => onNavigate("booking"), delay: 0.15 },
    { icon: Wrench, label: "Raise Maintenance Request", desc: "Flag broken equipment for repair approval", color: "bg-warning/20 text-warning", bg: "bg-surface hover:bg-surface-3", onClick: () => onNavigate("maintenance"), delay: 0.2 },
  ];

  return (
    <div className="w-full space-y-6">
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl text-sm font-medium shadow-xl border ${toast.type === "error" ? "bg-danger/25 border-danger/40 text-danger" : "bg-success/25 border-success/40 text-success"}`}
          >{toast.type === "error" ? <X size={14} className="inline mr-1.5" /> : <CheckCircle2 size={14} className="inline mr-1.5" />}{toast.msg}</motion.div>
        )}
      </AnimatePresence>

      {/* ── Welcome Bar + Controls ── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-xl font-bold text-ink sm:text-2xl">
            Welcome back, <span className="text-info">{username}</span> &#128075;
          </h1>
          <p className="text-xs text-ink-subtle mt-1">
            Here's what's happening across your organization today.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden sm:block text-[11px] text-ink-faint">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>

          <button aria-label="Refresh" onClick={fetchAll} disabled={refreshing} className="p-2 rounded-lg bg-surface border border-line hover:border-info/40 transition-colors">
            <RefreshCw size={14} className={`text-ink-muted ${refreshing ? "animate-spin" : ""}`} />
          </button>

          {/* Notifications */}
          <div className="relative">
            <button onClick={() => setShowNotif((v) => !v)} className="relative p-2 rounded-lg bg-surface border border-line hover:border-info/40 transition-colors">
              <Bell size={16} className="text-ink-muted" />
              {(kpi?.overdueReturns ?? 0) > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-danger text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {kpi?.overdueReturns}
                </span>
              )}
            </button>
            <AnimatePresence>
              {showNotif && (
                <NotificationPanel
                  activity={activity}
                  onClose={() => setShowNotif(false)}
                  onViewAll={() => {
                    setShowNotif(false);
                    onNavigate("activity");
                  }}
                />
              )}
            </AnimatePresence>
          </div>

          {/* User chip */}
          <div className="flex items-center gap-2 bg-surface border border-line rounded-xl px-3 py-1.5">
            <div className="w-6 h-6 rounded-full bg-info flex items-center justify-center text-[10px] font-bold text-white">
              {username[0]?.toUpperCase()}
            </div>
            <span className="text-xs text-ink-soft hidden sm:block">{session?.user.email}</span>
            <span className="text-[9px] bg-info/20 text-info border border-info/30 px-1.5 py-0.5 rounded-full font-bold">ADMIN</span>
          </div>
        </div>
      </div>

      {/* ── Data Error Banner ── */}
      {dataError && (
        <div className="flex items-center gap-3 bg-danger/10 border border-danger/30 rounded-2xl px-5 py-3">
          <AlertTriangle size={16} className="text-danger flex-shrink-0" />
          <p className="text-sm text-danger flex-1">{dataError}</p>
          <button
            aria-label="Refresh"
            onClick={fetchAll}
            className="text-xs bg-danger/20 hover:bg-danger/30 text-danger border border-danger/30 px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Overdue Alert Banner ── */}
      <AnimatePresence>
        {!loading && (kpi?.overdueReturns ?? 0) > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-danger/12 border border-danger/40 rounded-2xl px-5 py-3 flex items-center gap-3"
          >
            <AlertTriangle size={18} className="text-danger flex-shrink-0" />
            <p className="text-sm text-danger">
              <span className="font-bold text-danger">{kpi?.overdueReturns} assets</span> are overdue for return across the organization. Immediate action required.
            </p>
            <button onClick={() => onNavigate("allocations")} className="ml-auto text-xs bg-danger/20 hover:bg-danger/30 text-danger border border-danger/30 px-3 py-1 rounded-lg transition-colors flex-shrink-0">
              View All &#8594;
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── KPI Cards ── */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface border border-line rounded-2xl p-5 h-32 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {kpiCards.map((card, i) => <KPICard key={i} {...card} />)}
        </div>
      )}

      {/* ── Chart + Quick Actions ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="lg:col-span-2 bg-surface border border-line rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Asset Activity Overview</h2>
              <p className="text-xs text-ink-subtle">Allocated vs Available — last 8 days</p>
            </div>
            <span className="text-[11px] text-ink-faint bg-canvas border border-line px-2 py-1 rounded-lg">
              {new Date().toLocaleString("default", { month: "long", year: "numeric" })}
            </span>
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={chartData} barGap={4} barCategoryGap="28%">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--chart-grid))" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "hsl(var(--chart-tick))", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "hsl(var(--chart-tick))", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: "hsl(var(--chart-tick))", paddingTop: 6 }} formatter={(v) => <span style={{ color: "hsl(var(--chart-tick))" }}>{v}</span>} />
              <Bar dataKey="allocated" name="Allocated" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar dataKey="available" name="Available" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} opacity={0.6} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 mb-1">
            <Zap size={14} className="text-warning" />
            <h2 className="text-sm font-semibold text-ink">Quick Actions</h2>
          </div>
          {quickActions.map((action, i) => <QuickAction key={i} {...action} />)}
          <div className="mt-auto pt-3 border-t border-line grid grid-cols-2 gap-2">
            <div className="bg-canvas rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-success">{kpi?.assetsAvailable ?? "\u2014"}</p>
              <p className="text-[10px] text-ink-subtle">Available</p>
            </div>
            <div className="bg-canvas rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-danger">{kpi?.overdueReturns ?? "\u2014"}</p>
              <p className="text-[10px] text-ink-subtle">Overdue</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* ── Overdue Table + Recent Activity ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }} className="bg-surface border border-danger/20 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className="text-danger" />
              <h2 className="text-sm font-semibold text-ink">Overdue Returns</h2>
              <span className="text-[10px] bg-danger/20 text-danger border border-danger/30 px-2 py-0.5 rounded-full font-bold">{overdue.length}</span>
            </div>
            <button onClick={() => onNavigate("allocations")} className="text-xs text-info hover:text-info transition-colors">View all &#8594;</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ink-subtle border-b border-line">
                  <th className="px-5 py-2.5 text-left font-medium">Asset</th>
                  <th className="px-3 py-2.5 text-left font-medium">Employee</th>
                  <th className="px-3 py-2.5 text-left font-medium">Dept</th>
                  <th className="px-3 py-2.5 text-left font-medium">Days Late</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {overdue.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-3 transition-colors group">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-ink">{row.assetName}</p>
                      <p className="text-ink-subtle">{row.assetTag}</p>
                    </td>
                    <td className="px-3 py-3 text-ink-soft">{row.employee}</td>
                    <td className="px-3 py-3 text-ink-subtle">{row.dept}</td>
                    <td className="px-3 py-3">
                      <span className={`px-2 py-1 rounded-full font-bold ${
                        row.daysOverdue >= 7 ? "bg-danger/20 text-danger" : row.daysOverdue >= 3 ? "bg-warning/20 text-warning" : "bg-warning/20 text-warning"
                      }`}>+{row.daysOverdue}d</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overdue.length === 0 && (
              <div className="py-8 text-center text-ink-subtle text-xs">
                <CheckCircle2 size={24} className="mx-auto mb-2 text-success" />
                No overdue returns. All clear!
              </div>
            )}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="bg-surface border border-line rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <div className="flex items-center gap-2">
              <Activity size={15} className="text-info" />
              <h2 className="text-sm font-semibold text-ink">Recent Activity</h2>
            </div>
            <button onClick={() => onNavigate("activity")} className="text-xs text-info hover:text-info transition-colors">View all &#8594;</button>
          </div>
          <div className="divide-y divide-line">
            {activity.map((item, i) => (
              <motion.div key={item.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.55 + i * 0.04 }} className="px-5 py-3.5 flex items-start gap-3 hover:bg-surface-3 transition-colors">
                <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${statusDot[item.status]}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-ink-soft leading-snug">{item.text}</p>
                  <p className="text-[10px] text-ink-faint mt-0.5">{item.time}</p>
                </div>
              </motion.div>
            ))}
            {activity.length === 0 && <div className="py-8 text-center text-ink-subtle text-xs">No recent activity.</div>}
          </div>
        </motion.div>
      </div>

      {/* Register Asset Modal */}
      <RegisterAssetModal
        open={showRegister}
        onClose={() => setShowRegister(false)}
        onSuccess={(asset) => {
          setShowRegister(false);
          showToast(`"${asset.name}" registered with tag ${asset.assetTag}`);
          void fetchAll();
        }}
      />

      {/* ── Footer ── */}
      <div className="text-center text-[11px] text-ink pb-2">
        AssetFlow ERP &middot; Admin Portal &middot; Last updated {lastUpdated.toLocaleTimeString()}
      </div>
    </div>
  );
}
