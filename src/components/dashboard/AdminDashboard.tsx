import { useState, useEffect, useCallback } from "react";
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
  success: "bg-emerald-400", danger: "bg-red-400",
  warning: "bg-amber-400", info: "bg-blue-400",
};

const ChartTooltip = ({ active, payload, label }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-[#1e2235] border border-[#333] rounded-xl p-3 shadow-xl text-xs">
        <p className="text-gray-400 mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
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
  title: string; value: number | undefined; trend: string; icon: any; color: string; iconBg: string; isOverdue?: boolean; delay?: number;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
    transition={{ delay, duration: 0.4 }}
    className={`relative rounded-2xl p-5 border flex flex-col gap-3 overflow-hidden ${
      isOverdue ? "bg-red-950/40 border-red-500/40 shadow-[0_0_24px_rgba(239,68,68,0.15)]" : "bg-[#1a1d2e] border-[#2a2d3e]"
    }`}
  >
    {isOverdue && (
      <div className="absolute top-2 right-2">
        <span className="flex items-center gap-1 bg-red-500/20 text-red-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-red-500/30">
          <AlertTriangle size={9} /> CRITICAL
        </span>
      </div>
    )}
    <div className="flex items-start justify-between">
      <div>
        <p className={`text-xs font-medium tracking-wide uppercase ${isOverdue ? "text-red-400" : "text-gray-400"}`}>{title}</p>
        <p className={`text-3xl font-bold mt-1 ${isOverdue ? "text-red-400" : "text-white"}`}>{value ?? "\u2014"}</p>
      </div>
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${iconBg}`}>
        <Icon size={20} className={color} />
      </div>
    </div>
    <p className={`text-[11px] ${isOverdue ? "text-red-400/70" : "text-gray-500"}`}>{trend}</p>
  </motion.div>
);

const QuickAction = ({ icon: Icon, label, desc, color, bg, onClick, delay }: {
  icon: any; label: string; desc: string; color: string; bg: string; onClick: () => void; delay: number;
}) => (
  <motion.button
    initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
    transition={{ delay, duration: 0.3 }}
    whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
    onClick={onClick}
    className={`w-full flex items-center gap-4 p-4 rounded-xl border border-[#2a2d3e] ${bg} hover:border-[#3a3d4e] transition-all text-left group`}
  >
    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color} flex-shrink-0`}><Icon size={18} /></div>
    <div className="flex-1 min-w-0">
      <p className="text-sm font-semibold text-white">{label}</p>
      <p className="text-xs text-gray-500 truncate">{desc}</p>
    </div>
    <ChevronRight size={16} className="text-gray-600 group-hover:text-gray-400 transition-colors" />
  </motion.button>
);

const NotificationPanel = ({ activity, onClose }: { activity: ActivityItem[]; onClose: () => void }) => (
  <motion.div
    initial={{ opacity: 0, y: -10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, y: -10, scale: 0.95 }}
    className="absolute top-14 right-0 w-80 bg-[#1a1d2e] border border-[#2a2d3e] rounded-2xl shadow-2xl z-50 overflow-hidden"
  >
    <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2d3e]">
      <span className="text-sm font-semibold text-white">Notifications</span>
      <button onClick={onClose}><X size={14} className="text-gray-400 hover:text-white" /></button>
    </div>
    <div className="max-h-72 overflow-y-auto divide-y divide-[#2a2d3e]">
      {activity.slice(0, 6).map((a) => (
        <div key={a.id} className="px-4 py-3 hover:bg-[#22253a] transition-colors">
          <div className="flex items-start gap-2">
            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${statusDot[a.status]}`} />
            <div>
              <p className="text-xs text-gray-300 leading-snug">{a.text}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{a.time}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
    <div className="px-4 py-2 border-t border-[#2a2d3e]">
      <button className="text-xs text-blue-400 hover:text-blue-300 transition-colors">View all notifications</button>
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

  useEffect(() => {
    if (!isAdmin) return;
    fetchAll();
    const interval = setInterval(fetchAll, 60000); // Auto-refresh every 60s
    return () => clearInterval(interval);
  }, [isAdmin, fetchAll]);

  // ── Non-admin guard ──
  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#1a1d2e] border border-red-500/30 rounded-2xl p-8 text-center max-w-sm">
          <AlertTriangle size={40} className="text-red-400 mx-auto mb-3" />
          <p className="text-white font-bold text-lg">Access Denied</p>
          <p className="text-gray-400 text-sm mt-1">This dashboard is restricted to Admins only.</p>
          <button onClick={onSignOut} className="mt-4 px-4 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm hover:bg-red-500/30 transition-colors">
            Sign Out
          </button>
        </motion.div>
      </div>
    );
  }

  const username = session?.user?.name || session?.user?.email?.split("@")[0] || "Admin";

  const kpiCards = [
    { title: "Assets Available", value: kpi?.assetsAvailable, trend: kpi?.kpiTrends?.assetsAvailable ?? "\u2014", icon: Boxes, color: "text-emerald-400", iconBg: "bg-emerald-400/10", delay: 0.05 },
    { title: "Assets Allocated", value: kpi?.assetsAllocated, trend: kpi?.kpiTrends?.assetsAllocated ?? "\u2014", icon: Package, color: "text-blue-400", iconBg: "bg-blue-400/10", delay: 0.1 },
    { title: "Maintenance Today", value: kpi?.maintenanceToday, trend: kpi?.kpiTrends?.maintenanceToday ?? "\u2014", icon: Wrench, color: "text-amber-400", iconBg: "bg-amber-400/10", delay: 0.15 },
    { title: "Active Bookings", value: kpi?.activeBookings, trend: kpi?.kpiTrends?.activeBookings ?? "\u2014", icon: CalendarCheck, color: "text-purple-400", iconBg: "bg-purple-400/10", delay: 0.2 },
    { title: "Upcoming Returns", value: kpi?.upcomingReturns, trend: kpi?.kpiTrends?.upcomingReturns ?? "Next 7 days", icon: Clock, color: "text-cyan-400", iconBg: "bg-cyan-400/10", delay: 0.25 },
    { title: "Overdue Returns", value: kpi?.overdueReturns, trend: kpi?.kpiTrends?.overdueReturns ?? "Needs immediate action", icon: AlertTriangle, color: "text-red-400", iconBg: "bg-red-400/10", isOverdue: true, delay: 0.3 },
  ];

  const quickActions = [
    { icon: Plus, label: "Register Asset", desc: "Add a new asset to the inventory", color: "bg-emerald-500/20 text-emerald-400", bg: "bg-[#1a1d2e] hover:bg-[#1e2235]", onClick: () => setShowRegister(true), delay: 0.05 },
    { icon: Settings, label: "System Setup / Employee Directory", desc: "Manage departments, categories & promote roles", color: "bg-blue-500/20 text-blue-400", bg: "bg-[#1a1d2e] hover:bg-[#1e2235]", onClick: () => onNavigate("organization"), delay: 0.1 },
    { icon: CalendarCheck, label: "Book a Resource", desc: "Reserve conference rooms, vehicles & equipment", color: "bg-purple-500/20 text-purple-400", bg: "bg-[#1a1d2e] hover:bg-[#1e2235]", onClick: () => onNavigate("booking"), delay: 0.15 },
    { icon: Wrench, label: "Raise Maintenance Request", desc: "Flag broken equipment for repair approval", color: "bg-amber-500/20 text-amber-400", bg: "bg-[#1a1d2e] hover:bg-[#1e2235]", onClick: () => onNavigate("maintenance"), delay: 0.2 },
  ];

  return (
    <div className="w-full space-y-6">
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl text-sm font-medium shadow-xl border ${toast.type === "error" ? "bg-red-950 border-red-500/40 text-red-300" : "bg-emerald-950 border-emerald-500/40 text-emerald-300"}`}
          >{toast.type === "error" ? <X size={14} className="inline mr-1.5" /> : <CheckCircle2 size={14} className="inline mr-1.5" />}{toast.msg}</motion.div>
        )}
      </AnimatePresence>

      {/* ── Welcome Bar + Controls ── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-xl font-bold text-white sm:text-2xl">
            Welcome back, <span className="text-blue-400">{username}</span> &#128075;
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Here's what's happening across your organization today.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden sm:block text-[11px] text-gray-600">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>

          <button onClick={fetchAll} disabled={refreshing} className="p-2 rounded-lg bg-[#1a1d2e] border border-[#2a2d3e] hover:border-blue-500/40 transition-colors">
            <RefreshCw size={14} className={`text-gray-400 ${refreshing ? "animate-spin" : ""}`} />
          </button>

          {/* Notifications */}
          <div className="relative">
            <button onClick={() => setShowNotif((v) => !v)} className="relative p-2 rounded-lg bg-[#1a1d2e] border border-[#2a2d3e] hover:border-blue-500/40 transition-colors">
              <Bell size={16} className="text-gray-400" />
              {(kpi?.overdueReturns ?? 0) > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {kpi?.overdueReturns}
                </span>
              )}
            </button>
            <AnimatePresence>
              {showNotif && <NotificationPanel activity={activity} onClose={() => setShowNotif(false)} />}
            </AnimatePresence>
          </div>

          {/* User chip */}
          <div className="flex items-center gap-2 bg-[#1a1d2e] border border-[#2a2d3e] rounded-xl px-3 py-1.5">
            <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-[10px] font-bold text-white">
              {username[0]?.toUpperCase()}
            </div>
            <span className="text-xs text-gray-300 hidden sm:block">{session?.user.email}</span>
            <span className="text-[9px] bg-blue-500/20 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded-full font-bold">ADMIN</span>
          </div>
        </div>
      </div>

      {/* ── Data Error Banner ── */}
      {dataError && (
        <div className="flex items-center gap-3 bg-red-950/40 border border-red-500/30 rounded-2xl px-5 py-3">
          <AlertTriangle size={16} className="text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300 flex-1">{dataError}</p>
          <button
            onClick={fetchAll}
            className="text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
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
            className="bg-red-950/50 border border-red-500/40 rounded-2xl px-5 py-3 flex items-center gap-3"
          >
            <AlertTriangle size={18} className="text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-300">
              <span className="font-bold text-red-400">{kpi?.overdueReturns} assets</span> are overdue for return across the organization. Immediate action required.
            </p>
            <button onClick={() => onNavigate("allocations")} className="ml-auto text-xs bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 px-3 py-1 rounded-lg transition-colors flex-shrink-0">
              View All &#8594;
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── KPI Cards ── */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#1a1d2e] border border-[#2a2d3e] rounded-2xl p-5 h-32 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {kpiCards.map((card, i) => <KPICard key={i} {...card} />)}
        </div>
      )}

      {/* ── Chart + Quick Actions ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="lg:col-span-2 bg-[#1a1d2e] border border-[#2a2d3e] rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Asset Activity Overview</h2>
              <p className="text-xs text-gray-500">Allocated vs Available — last 8 days</p>
            </div>
            <span className="text-[11px] text-gray-600 bg-[#0f111a] border border-[#2a2d3e] px-2 py-1 rounded-lg">
              {new Date().toLocaleString("default", { month: "long", year: "numeric" })}
            </span>
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={chartData} barGap={4} barCategoryGap="28%">
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2235" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#9ca3af", paddingTop: 6 }} formatter={(v) => <span style={{ color: "#9ca3af" }}>{v}</span>} />
              <Bar dataKey="allocated" name="Allocated" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar dataKey="available" name="Available" fill="#60a5fa" radius={[4, 4, 0, 0]} opacity={0.6} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="bg-[#1a1d2e] border border-[#2a2d3e] rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 mb-1">
            <Zap size={14} className="text-yellow-400" />
            <h2 className="text-sm font-semibold text-white">Quick Actions</h2>
          </div>
          {quickActions.map((action, i) => <QuickAction key={i} {...action} />)}
          <div className="mt-auto pt-3 border-t border-[#2a2d3e] grid grid-cols-2 gap-2">
            <div className="bg-[#0f111a] rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-emerald-400">{kpi?.assetsAvailable ?? "\u2014"}</p>
              <p className="text-[10px] text-gray-500">Available</p>
            </div>
            <div className="bg-[#0f111a] rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-red-400">{kpi?.overdueReturns ?? "\u2014"}</p>
              <p className="text-[10px] text-gray-500">Overdue</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* ── Overdue Table + Recent Activity ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }} className="bg-[#1a1d2e] border border-red-500/20 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2d3e]">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className="text-red-400" />
              <h2 className="text-sm font-semibold text-white">Overdue Returns</h2>
              <span className="text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-full font-bold">{overdue.length}</span>
            </div>
            <button onClick={() => onNavigate("allocations")} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">View all &#8594;</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-[#2a2d3e]">
                  <th className="px-5 py-2.5 text-left font-medium">Asset</th>
                  <th className="px-3 py-2.5 text-left font-medium">Employee</th>
                  <th className="px-3 py-2.5 text-left font-medium">Dept</th>
                  <th className="px-3 py-2.5 text-left font-medium">Days Late</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e2235]">
                {overdue.map((row) => (
                  <tr key={row.id} className="hover:bg-[#1e2235] transition-colors group">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-white">{row.assetName}</p>
                      <p className="text-gray-500">{row.assetTag}</p>
                    </td>
                    <td className="px-3 py-3 text-gray-300">{row.employee}</td>
                    <td className="px-3 py-3 text-gray-500">{row.dept}</td>
                    <td className="px-3 py-3">
                      <span className={`px-2 py-1 rounded-full font-bold ${
                        row.daysOverdue >= 7 ? "bg-red-500/20 text-red-400" : row.daysOverdue >= 3 ? "bg-amber-500/20 text-amber-400" : "bg-orange-500/20 text-orange-400"
                      }`}>+{row.daysOverdue}d</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overdue.length === 0 && (
              <div className="py-8 text-center text-gray-500 text-xs">
                <CheckCircle2 size={24} className="mx-auto mb-2 text-emerald-500" />
                No overdue returns. All clear!
              </div>
            )}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="bg-[#1a1d2e] border border-[#2a2d3e] rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2d3e]">
            <div className="flex items-center gap-2">
              <Activity size={15} className="text-blue-400" />
              <h2 className="text-sm font-semibold text-white">Recent Activity</h2>
            </div>
            <button onClick={() => onNavigate("activity")} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">View all &#8594;</button>
          </div>
          <div className="divide-y divide-[#1e2235]">
            {activity.map((item, i) => (
              <motion.div key={item.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.55 + i * 0.04 }} className="px-5 py-3.5 flex items-start gap-3 hover:bg-[#1e2235] transition-colors">
                <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${statusDot[item.status]}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-300 leading-snug">{item.text}</p>
                  <p className="text-[10px] text-gray-600 mt-0.5">{item.time}</p>
                </div>
              </motion.div>
            ))}
            {activity.length === 0 && <div className="py-8 text-center text-gray-500 text-xs">No recent activity.</div>}
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
          fetchAll();
        }}
      />

      {/* ── Footer ── */}
      <div className="text-center text-[11px] text-gray-700 pb-2">
        AssetFlow ERP &middot; Admin Portal &middot; Last updated {lastUpdated.toLocaleTimeString()}
      </div>
    </div>
  );
}
