import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Package,
  CalendarCheck,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Activity,
  Bell,
  RefreshCw,
  X,
  Zap,
  Wrench,
  ArrowLeftRight,
  BookOpen,
  Laptop,
  Smartphone,
  Monitor,
  Printer,
  Camera,
  Tag,
  MapPin,
  Calendar,
  CircleAlert,
  Info,
  BadgeCheck,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { getSession } from "@/lib/auth";
import { apiGet, apiSend } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/dialog";
import { usePolling } from "@/hooks/usePolling";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
interface KPIData {
  myAllocatedAssets: number;
  myActiveBookings: number;
  myUpcomingReturns: number;
  myOverdueReturns: number;
  kpiTrends: {
    myAllocatedAssets: string;
    myActiveBookings: string;
    myUpcomingReturns: string;
    myOverdueReturns: string;
  };
}

interface MyAsset {
  id: number;
  assetTag: string;
  assetName: string;
  category: string;
  condition: string;
  allocatedOn: string;
  expectedReturn: string | null;
  status: string;
  icon: string;
}

interface MyBooking {
  id: number;
  _id?: string;
  resource: string;
  date: string;
  start: string;
  end: string;
  status: string;
  location: string;
}

interface MyMaintenance {
  id: number;
  assetTag: string;
  assetName: string;
  issue: string;
  status: string;
  raisedOn: string;
  priority: string;
}

interface ActivityItem {
  id: number;
  text: string;
  time: string;
  status: string;
}

interface ChartItem {
  month: string;
  assets: number;
}

interface Toast {
  msg: string;
  type: string;
}

interface EmployeeDashboardProps {
  onNavigate: (view: string) => void;
  onSignOut: () => void;
}

// ─────────────────────────────────────────────────────────────
// API SERVICE (real backend — no fake data; failures surface as errors)
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// HELPERS (display mapping)
// ─────────────────────────────────────────────────────────────
const titleCase = (s: string) =>
  s.replace(/_/g, " ").replace(/(^|\s)\w/g, (m) => m.toUpperCase());

const statusForAction = (action: string): string => {
  if (action.includes("overdue") || action.includes("reject")) return "danger";
  if (action.includes("maintenance") || action.includes("transfer")) return "warning";
  if (action.includes("booking")) return "info";
  return "success";
};

const prettyAction = (action: string) =>
  action.replace(/\./g, " ").replace(/(^|\s)\w/g, (m) => m.toUpperCase());

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const MT_STATUS: Record<string, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  TECHNICIAN_ASSIGNED: "Assigned",
  IN_PROGRESS: "InProgress",
  RESOLVED: "Resolved",
};

// ─────────────────────────────────────────────────────────────
// API SERVICE (real backend)
// ─────────────────────────────────────────────────────────────
const apiService = {
  getKPIs: async (): Promise<KPIData> => {
    const d = await apiGet<{
      myAllocations: number;
      myActiveBookings: number;
      myUpcomingReturns: number;
      myOverdueReturns: number;
    }>("/reports/dashboard/employee/kpis");
    return {
      myAllocatedAssets: d.myAllocations ?? 0,
      myActiveBookings: d.myActiveBookings ?? 0,
      myUpcomingReturns: d.myUpcomingReturns ?? 0,
      myOverdueReturns: d.myOverdueReturns ?? 0,
      kpiTrends: {
        myAllocatedAssets: "Items currently in your possession",
        myActiveBookings: "Rooms/resources reserved by you",
        myUpcomingReturns: "Due within next 7 days",
        myOverdueReturns: "Please return immediately",
      },
    };
  },
  getMyAssets: async (): Promise<MyAsset[]> => {
    const data = await apiGet<{ items: Array<{
      id: string; status: string; expectedReturnDate: string | null; allocatedAt: string;
      asset?: { assetTag: string; name: string; condition: string; category?: { name: string } };
    }> }>("/allocations/my");
    const now = Date.now();
    return data.items.map((a, i) => {
      const expected = a.expectedReturnDate ? a.expectedReturnDate.slice(0, 10) : null;
      const isOverdue = a.status === "ACTIVE" && expected && new Date(expected).getTime() < now;
      return {
        id: i + 1,
        assetTag: a.asset?.assetTag ?? "",
        assetName: a.asset?.name ?? "Asset",
        category: a.asset?.category?.name ?? "—",
        condition: a.asset?.condition ?? "—",
        allocatedOn: a.allocatedAt?.slice(0, 10) ?? "",
        expectedReturn: expected,
        status: a.status === "RETURNED" ? "Returned" : isOverdue ? "Overdue" : "Allocated",
        icon: "tag",
      };
    });
  },
  getMyBookings: async (): Promise<MyBooking[]> => {
    const data = await apiGet<{ items: Array<{
      id: string; effectiveStatus: string; startTime: string; endTime: string;
      asset?: { name: string; location?: string | null };
    }> }>("/bookings/my");
    return data.items.map((b, i) => ({
      id: i + 1,
      _id: b.id,
      resource: b.asset?.name ?? "Resource",
      date: b.startTime.slice(0, 10),
      start: fmtTime(b.startTime),
      end: fmtTime(b.endTime),
      status: titleCase(b.effectiveStatus),
      location: b.asset?.location ?? "—",
    }));
  },
  getMyMaintenance: async (): Promise<MyMaintenance[]> => {
    const data = await apiGet<{ items: Array<{
      id: string; status: string; priority: string; description: string; createdAt: string;
      asset?: { assetTag: string; name: string };
    }> }>("/maintenance/my");
    return data.items.map((r, i) => ({
      id: i + 1,
      assetTag: r.asset?.assetTag ?? "",
      assetName: r.asset?.name ?? "Asset",
      issue: r.description,
      status: MT_STATUS[r.status] ?? titleCase(r.status),
      raisedOn: r.createdAt.slice(0, 10),
      priority: titleCase(r.priority),
    }));
  },
  getMyActivity: async (): Promise<ActivityItem[]> => {
    const data = await apiGet<{ items: Array<{ action: string; createdAt: string }> }>(
      "/reports/dashboard/employee/activity",
    );
    return data.items.map((a, i) => ({
      id: i + 1,
      text: prettyAction(a.action),
      time: new Date(a.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      status: statusForAction(a.action),
    }));
  },
  getMyChart: async (): Promise<ChartItem[]> => {
    const data = await apiGet<ChartItem[]>("/reports/dashboard/employee/chart");
    return Array.isArray(data) ? data : [];
  },
  cancelBooking: async (id: number | string): Promise<boolean> => {
    try {
      await apiSend(`/bookings/${id}/cancel`, "POST");
      return true;
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const statusDot: Record<string, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
};

const assetIconMap: Record<string, React.ReactNode> = {
  laptop: <Laptop size={16} />,
  phone: <Smartphone size={16} />,
  monitor: <Monitor size={16} />,
  printer: <Printer size={16} />,
  camera: <Camera size={16} />,
  tag: <Tag size={16} />,
};

const priorityStyle: Record<string, string> = {
  High: "bg-danger/20 text-danger border border-danger/30",
  Medium: "bg-warning/20 text-warning border border-warning/30",
  Low: "bg-success/20 text-success border border-success/30",
};

const maintenanceStatusStyle: Record<string, string> = {
  Pending: "bg-ink-subtle/20 text-ink-muted border border-line-strong/30",
  InProgress: "bg-info/20 text-info border border-info/30",
  Resolved: "bg-success/20 text-success border border-success/30",
  Approved: "bg-violet/20 text-violet border border-violet/30",
};

const bookingStatusStyle: Record<string, string> = {
  Upcoming: "bg-info/20 text-info border border-info/30",
  Ongoing: "bg-success/20 text-success border border-success/30",
  Completed: "bg-ink-subtle/20 text-ink-muted border border-line-strong/30",
  Cancelled: "bg-danger/20 text-danger border border-danger/30",
};

const isDaysAway = (dateStr: string | null): number | null => {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
};

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ color: string; name: string; value: number }>; label?: string }) => {
  if (active && payload?.length) {
    return (
      <div className="bg-surface-3 border border-[#333] rounded-xl p-3 shadow-xl text-xs">
        <p className="text-ink-muted mb-1">{label}</p>
        {payload.map((e, i) => (
          <p key={i} style={{ color: e.color }} className="font-semibold">
            {e.name}: {e.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

// ─────────────────────────────────────────────────────────────
// KPI CARD
// ─────────────────────────────────────────────────────────────
const KPICard = ({
  title,
  value,
  trend,
  icon: Icon,
  color,
  iconBg,
  isOverdue,
  delay,
}: {
  title: string;
  value?: number;
  trend?: string;
  icon: LucideIcon;
  color: string;
  iconBg: string;
  isOverdue?: boolean;
  delay: number;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay, duration: 0.4 }}
    className={`relative rounded-2xl p-5 border flex flex-col gap-3 overflow-hidden
      ${
        isOverdue
          ? "bg-danger/10 border-danger/40 shadow-[0_0_24px_rgba(239,68,68,0.15)]"
          : "bg-surface border-line"
      }`}
  >
    {isOverdue && (
      <div className="absolute top-2 right-2">
        <span className="flex items-center gap-1 bg-danger/20 text-danger text-[10px] font-bold px-2 py-0.5 rounded-full border border-danger/30">
          <AlertTriangle size={9} /> RETURN NOW
        </span>
      </div>
    )}
    <div className="flex items-start justify-between">
      <div>
        <p className={`text-xs font-medium tracking-wide uppercase ${isOverdue ? "text-danger" : "text-ink-muted"}`}>
          {title}
        </p>
        <p className={`text-3xl font-bold mt-1 ${isOverdue ? "text-danger" : "text-ink"}`}>
          {value ?? "\u2014"}
        </p>
      </div>
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${iconBg}`}>
        <Icon size={20} className={color} />
      </div>
    </div>
    <p className={`text-[11px] ${isOverdue ? "text-danger/70" : "text-ink-subtle"}`}>{trend}</p>
  </motion.div>
);

// ─────────────────────────────────────────────────────────────
// QUICK ACTION
// ─────────────────────────────────────────────────────────────
const QuickAction = ({
  icon: Icon,
  label,
  desc,
  color,
  onClick,
  delay,
}: {
  icon: LucideIcon;
  label: string;
  desc: string;
  color: string;
  onClick: () => void;
  delay: number;
}) => (
  <motion.button
    initial={{ opacity: 0, x: -10 }}
    animate={{ opacity: 1, x: 0 }}
    transition={{ delay, duration: 0.3 }}
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.98 }}
    onClick={onClick}
    className="w-full flex items-center gap-3 p-4 rounded-xl border border-line bg-surface hover:border-line hover:bg-surface-3 transition-all text-left group"
  >
    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color} flex-shrink-0`}>
      <Icon size={18} />
    </div>
    <div className="flex-1 min-w-0">
      <p className="text-sm font-semibold text-ink">{label}</p>
      <p className="text-xs text-ink-subtle truncate">{desc}</p>
    </div>
    <ChevronRight size={15} className="text-ink-faint group-hover:text-ink-muted transition-colors flex-shrink-0" />
  </motion.button>
);

// ─────────────────────────────────────────────────────────────
// NOTIFICATION PANEL
// ─────────────────────────────────────────────────────────────
const NotificationPanel = ({
  activity,
  overdueCount,
  onClose,
}: {
  activity: ActivityItem[];
  overdueCount: number;
  onClose: () => void;
}) => (
  <motion.div
    initial={{ opacity: 0, y: -10, scale: 0.95 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, y: -10, scale: 0.95 }}
    className="absolute top-14 right-0 w-80 bg-surface border border-line rounded-2xl shadow-2xl z-50 overflow-hidden"
  >
    <div className="flex items-center justify-between px-4 py-3 border-b border-line">
      <span className="text-sm font-semibold text-ink">My Notifications</span>
      <button aria-label="Close" onClick={onClose}>
        <X size={14} className="text-ink-muted hover:text-ink" />
      </button>
    </div>
    {overdueCount > 0 && (
      <div className="px-4 py-2 bg-danger/10 border-b border-danger/20">
        <p className="text-xs text-danger flex items-center gap-1.5">
          <AlertTriangle size={11} /> You have {overdueCount} overdue asset{overdueCount > 1 ? "s" : ""}. Please return immediately.
        </p>
      </div>
    )}
    <div className="max-h-64 overflow-y-auto divide-y divide-line">
      {activity.map((a) => (
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
      <p className="text-[10px] text-ink-faint text-center">Showing your most recent activity</p>
    </div>
  </motion.div>
);

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────
const EmployeeDashboard = ({ onNavigate, onSignOut }: EmployeeDashboardProps) => {
  const session = getSession();

  const [kpi, setKpi] = useState<KPIData | null>(null);
  const [myAssets, setMyAssets] = useState<MyAsset[]>([]);
  const [myBookings, setMyBookings] = useState<MyBooking[]>([]);
  const [myMaint, setMyMaint] = useState<MyMaintenance[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [chartData, setChartData] = useState<ChartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [toast, setToast] = useState<Toast | null>(null);
  const [cancelLoading, setCancelLoading] = useState<Record<number, boolean>>({});

  const isEmployee = session?.user?.role === "EMPLOYEE";

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    setDataError(null);
    try {
      const [k, assets, bookings, maint, act, chart] = await Promise.all([
        apiService.getKPIs(),
        apiService.getMyAssets(),
        apiService.getMyBookings(),
        apiService.getMyMaintenance(),
        apiService.getMyActivity(),
        apiService.getMyChart(),
      ]);
      setKpi(k);
      setMyAssets(assets);
      setMyBookings(bookings);
      setMyMaint(maint);
      setActivity(act);
      setChartData(chart);
      setLastUpdated(new Date());
    } catch (err) {
      setDataError(
        err instanceof Error
          ? err.message
          : "Failed to load your dashboard. Check that the backend is running.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Auto-refresh every 60s — no overlapping requests, nothing while the
  // tab is hidden.
  usePolling(fetchAll, 60_000, isEmployee);

  // Cancelling a booking takes the slot away from everyone, so it asks first.
  const [cancelTarget, setCancelTarget] = useState<{
    id: number | string;
    resource: string;
  } | null>(null);

  const handleCancelBooking = async (id: number | string) => {
    setCancelLoading((p) => ({ ...p, [id]: true }));
    const ok = await apiService.cancelBooking(id);
    if (ok) {
      setMyBookings((prev) => prev.map((b) => (b.id === id || b._id === id ? { ...b, status: "Cancelled" } : b)));
      setKpi((prev) => (prev ? { ...prev, myActiveBookings: Math.max(0, (prev.myActiveBookings || 1) - 1) } : prev));
      showToast("Booking cancelled successfully");
    } else {
      showToast("Failed to cancel booking. Try again.", "error");
    }
    setCancelLoading((p) => ({ ...p, [id]: false }));
  };

  const username = session?.user?.name || session?.user?.email?.split("@")[0] || "Employee";

  const kpiCards = [
    { title: "My Allocated Assets", value: kpi?.myAllocatedAssets, trend: kpi?.kpiTrends?.myAllocatedAssets, icon: Package, color: "text-info", iconBg: "bg-info/10", delay: 0.05 },
    { title: "My Active Bookings", value: kpi?.myActiveBookings, trend: kpi?.kpiTrends?.myActiveBookings, icon: CalendarCheck, color: "text-violet", iconBg: "bg-violet/10", delay: 0.1 },
    { title: "My Upcoming Returns", value: kpi?.myUpcomingReturns, trend: kpi?.kpiTrends?.myUpcomingReturns, icon: Clock, color: "text-cyan-400", iconBg: "bg-cyan-400/10", delay: 0.15 },
    { title: "My Overdue Returns", value: kpi?.myOverdueReturns, trend: kpi?.kpiTrends?.myOverdueReturns, icon: AlertTriangle, color: "text-danger", iconBg: "bg-danger/10", isOverdue: true, delay: 0.2 },
  ];

  const quickActions = [
    { icon: BookOpen, label: "Book a Resource", desc: "Reserve a room, vehicle or equipment", color: "bg-violet/20 text-violet", onClick: () => onNavigate("booking"), delay: 0.05 },
    { icon: Wrench, label: "Raise Maintenance Request", desc: "Report a broken or faulty asset", color: "bg-warning/20 text-warning", onClick: () => onNavigate("maintenance"), delay: 0.1 },
    { icon: ArrowLeftRight, label: "Initiate Transfer / Return", desc: "Hand over or return an asset", color: "bg-info/20 text-info", onClick: () => onNavigate("transfers"), delay: 0.15 },
  ];

  const overdueAssets = myAssets.filter((a) => a.status === "Overdue");

  // ── Access guard (AFTER all hooks) ──
  if (!isEmployee) {
    return (
      <div className="bg-canvas rounded-xl border border-danger/30 flex flex-col items-center justify-center py-32">
        <AlertTriangle size={40} className="text-danger mb-3" />
        <p className="text-ink font-bold text-lg">Access Denied</p>
        <p className="text-ink-subtle text-sm mt-1">This dashboard is for standard employees only.</p>
        <button onClick={onSignOut} className="mt-4 px-4 py-2 bg-danger/20 text-danger rounded-lg text-sm hover:bg-danger/30 transition-colors">
          Sign Out
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* ── TOAST ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl text-sm font-medium shadow-xl border
              ${
                toast.type === "error"
                  ? "bg-danger/25 border-danger/40 text-danger"
                  : "bg-success/25 border-success/40 text-success"
              }`}
          >
            {toast.type === "error" ? (
              <X size={14} className="inline mr-1.5" />
            ) : (
              <CheckCircle2 size={14} className="inline mr-1.5" />
            )}
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── DATA ERROR BANNER ── */}
      {dataError && (
        <div className="flex items-center gap-3 bg-danger/10 border border-danger/30 rounded-2xl px-5 py-3 mb-6">
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

      {/* ── HEADER ── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink">
            Welcome back, <span className="text-info">{username}</span>
          </h1>
          <p className="text-xs text-ink-subtle mt-0.5">Your personal asset & resource portal</p>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden sm:block text-[11px] text-ink-faint">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>

          <button
            aria-label="Refresh"
            onClick={fetchAll}
            disabled={refreshing}
            className="p-2 rounded-lg bg-surface border border-line hover:border-info/40 transition-colors"
          >
            <RefreshCw size={14} className={`text-ink-muted ${refreshing ? "animate-spin" : ""}`} />
          </button>

          {/* Notification Bell */}
          <div className="relative">
            <button
              onClick={() => setShowNotif((v) => !v)}
              className="relative p-2 rounded-lg bg-surface border border-line hover:border-info/40 transition-colors"
            >
              <Bell size={16} className="text-ink-muted" />
              {(kpi?.myOverdueReturns ?? 0) > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-danger text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {kpi?.myOverdueReturns ?? 0}
                </span>
              )}
            </button>
            <AnimatePresence>
              {showNotif && (
                <NotificationPanel
                  activity={activity}
                  overdueCount={kpi?.myOverdueReturns ?? 0}
                  onClose={() => setShowNotif(false)}
                />
              )}
            </AnimatePresence>
          </div>

          <div className="flex items-center gap-2 bg-surface border border-line rounded-xl px-3 py-1.5">
            <div className="w-6 h-6 rounded-full bg-info flex items-center justify-center text-[10px] font-bold text-white">
              {username[0]?.toUpperCase()}
            </div>
            <span className="text-xs text-ink-soft hidden sm:block">{session?.user?.email}</span>
            <span className="text-[9px] bg-success/20 text-success border border-success/30 px-1.5 py-0.5 rounded-full font-bold">
              EMPLOYEE
            </span>
          </div>
        </div>
      </div>

      {/* ── MAIN ── */}
      <div className="space-y-6">
        {/* ── OVERDUE ALERT BANNER ── */}
        <AnimatePresence>
          {!loading && overdueAssets.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-danger/12 border border-danger/40 rounded-2xl px-5 py-4"
            >
              <div className="flex items-start gap-3">
                <CircleAlert size={18} className="text-danger flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-bold text-danger mb-1">
                    You have {overdueAssets.length} overdue asset{overdueAssets.length > 1 ? "s" : ""}!
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {overdueAssets.map((a) => (
                      <span key={a.id} className="text-xs bg-danger/10 border border-danger/20 text-danger px-2 py-1 rounded-lg">
                        {a.assetName} <span className="text-danger">({a.assetTag})</span>
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-danger/70 mt-2">
                    Please return these items to IT or contact your Asset Manager immediately.
                  </p>
                </div>
                <button
                  onClick={() => onNavigate("transfers")}
                  className="flex-shrink-0 text-xs bg-danger/20 hover:bg-danger/30 text-danger border border-danger/30 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Initiate Return &rarr;
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── KPI CARDS ── */}
        {loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-surface border border-line rounded-2xl p-5 h-32 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {kpiCards.map((card, i) => (
              <KPICard key={i} {...card} />
            ))}
          </div>
        )}

        {/* ── ROW 2: My Assets + Quick Actions ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* My Assets — 2/3 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, type: "spring" as const, stiffness: 100 }}
            className="lg:col-span-2 bg-surface border border-line rounded-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center gap-2">
                <Package size={15} className="text-info" />
                <h2 className="text-sm font-semibold text-ink">My Allocated Assets</h2>
                <span className="text-[10px] bg-info/20 text-info border border-info/30 px-2 py-0.5 rounded-full font-bold">
                  {myAssets.length}
                </span>
              </div>
              <button onClick={() => onNavigate("my-assets")} className="text-xs text-info hover:text-info transition-colors">
                View all &rarr;
              </button>
            </div>

            <div className="divide-y divide-line">
              {myAssets.map((asset, i) => {
                const daysLeft = isDaysAway(asset.expectedReturn);
                const isOverdue = asset.status === "Overdue" || (daysLeft !== null && daysLeft < 0);
                const isDueSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;

                return (
                  <motion.div
                    key={asset.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.32 + i * 0.05 }}
                    className={`px-5 py-4 hover:bg-surface-3 transition-colors ${isOverdue ? "bg-danger/5" : ""}`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0
                        ${isOverdue ? "bg-danger/20 text-danger" : "bg-info/15 text-info"}`}
                      >
                        {assetIconMap[asset.icon] ?? <Tag size={16} />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-ink">{asset.assetName}</p>
                          <span className="text-[11px] text-ink-subtle">{asset.assetTag}</span>
                          {isOverdue && (
                            <span className="text-[10px] bg-danger/20 text-danger border border-danger/30 px-1.5 py-0.5 rounded-full font-bold">
                              OVERDUE
                            </span>
                          )}
                          {isDueSoon && !isOverdue && (
                            <span className="text-[10px] bg-warning/20 text-warning border border-warning/30 px-1.5 py-0.5 rounded-full font-bold">
                              DUE SOON
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                          <span className="text-[11px] text-ink-subtle flex items-center gap-1">
                            <Tag size={10} /> {asset.category}
                          </span>
                          <span className="text-[11px] text-ink-subtle flex items-center gap-1">
                            <BadgeCheck size={10} /> {asset.condition}
                          </span>
                          {asset.expectedReturn ? (
                            <span
                              className={`text-[11px] flex items-center gap-1
                              ${isOverdue ? "text-danger" : isDueSoon ? "text-warning" : "text-ink-subtle"}`}
                            >
                              <Calendar size={10} />
                              {isOverdue
                                ? `Overdue by ${Math.abs(daysLeft!)}d`
                                : `Return in ${daysLeft}d (${asset.expectedReturn})`}
                            </span>
                          ) : (
                            <span className="text-[11px] text-ink-faint flex items-center gap-1">
                              <Calendar size={10} /> No return date
                            </span>
                          )}
                        </div>
                      </div>

                      <button
                        onClick={() => onNavigate("my-assets")}
                        className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-line text-ink-muted hover:border-info/40 hover:text-info transition-all"
                      >
                        Details
                      </button>
                    </div>
                  </motion.div>
                );
              })}

              {myAssets.length === 0 && (
                <div className="py-10 text-center text-ink-subtle text-xs">
                  <Package size={28} className="mx-auto mb-2 opacity-30" />
                  No assets allocated to you yet.
                </div>
              )}
            </div>
          </motion.div>

          {/* Quick Actions + Mini Chart — 1/3 */}
          <div className="flex flex-col gap-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.32, type: "spring" as const, stiffness: 100 }}
              className="bg-surface border border-line rounded-2xl p-4 flex flex-col gap-2.5"
            >
              <div className="flex items-center gap-2 mb-1">
                <Zap size={13} className="text-warning" />
                <h2 className="text-sm font-semibold text-ink">Quick Actions</h2>
              </div>
              {quickActions.map((action, i) => (
                <QuickAction key={i} {...action} />
              ))}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.36, type: "spring" as const, stiffness: 100 }}
              className="bg-surface border border-line rounded-2xl p-4"
            >
              <p className="text-sm font-semibold text-ink mb-1">My Assets Over Time</p>
              <p className="text-xs text-ink-subtle mb-3">How many items you've held</p>
              <ResponsiveContainer width="100%" height={90}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="areaGradEmp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--chart-grid))" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: "hsl(var(--chart-tick))", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="assets" name="Assets" stroke="hsl(var(--chart-1))" fill="url(#areaGradEmp)" strokeWidth={2} dot={{ fill: "hsl(var(--chart-1))", r: 3 }} />
                </AreaChart>
              </ResponsiveContainer>
            </motion.div>
          </div>
        </div>

        {/* ── ROW 3: My Bookings + Maintenance Requests ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* My Bookings */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.42, type: "spring" as const, stiffness: 100 }}
            className="bg-surface border border-line rounded-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center gap-2">
                <CalendarCheck size={15} className="text-violet" />
                <h2 className="text-sm font-semibold text-ink">My Resource Bookings</h2>
                <span className="text-[10px] bg-violet/20 text-violet border border-violet/30 px-2 py-0.5 rounded-full font-bold">
                  {myBookings.filter((b) => b.status === "Upcoming").length} upcoming
                </span>
              </div>
              <button onClick={() => onNavigate("booking")} className="text-xs text-info hover:text-info transition-colors">
                Book new &rarr;
              </button>
            </div>

            <div className="divide-y divide-line">
              {myBookings.map((booking, i) => (
                <motion.div
                  key={booking.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.44 + i * 0.04 }}
                  className="px-5 py-4 hover:bg-surface-3 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <p className="text-sm font-semibold text-ink">{booking.resource}</p>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${bookingStatusStyle[booking.status]}`}>
                          {booking.status}
                        </span>
                      </div>
                      <p className="text-xs text-ink-muted flex items-center gap-1.5">
                        <Calendar size={10} />
                        {booking.date} &middot; {booking.start} - {booking.end}
                      </p>
                      <p className="text-[11px] text-ink-faint flex items-center gap-1 mt-0.5">
                        <MapPin size={10} /> {booking.location}
                      </p>
                    </div>
                    {booking.status === "Upcoming" && (
                      <button
                        disabled={cancelLoading[booking.id]}
                        onClick={() =>
                          setCancelTarget({
                            id: booking._id ?? booking.id,
                            resource: booking.resource ?? "this resource",
                          })
                        }
                        className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-lg bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-colors disabled:opacity-50"
                      >
                        {cancelLoading[booking.id] ? "..." : "Cancel"}
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}

              {myBookings.length === 0 && (
                <div className="py-10 text-center text-ink-subtle text-xs">
                  <CalendarCheck size={28} className="mx-auto mb-2 opacity-30" />
                  No bookings yet.
                  <button onClick={() => onNavigate("booking")} className="block mx-auto mt-2 text-info hover:underline">
                    Book a resource &rarr;
                  </button>
                </div>
              )}
            </div>
          </motion.div>

          {/* My Maintenance Requests */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.46, type: "spring" as const, stiffness: 100 }}
            className="bg-surface border border-line rounded-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center gap-2">
                <Wrench size={15} className="text-warning" />
                <h2 className="text-sm font-semibold text-ink">My Maintenance Requests</h2>
              </div>
              <button onClick={() => onNavigate("maintenance")} className="text-xs text-info hover:text-info transition-colors">
                Raise new &rarr;
              </button>
            </div>

            <div className="divide-y divide-line">
              {myMaint.map((req, i) => (
                <motion.div
                  key={req.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.48 + i * 0.04 }}
                  className="px-5 py-4 hover:bg-surface-3 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <p className="text-sm font-semibold text-ink">{req.assetName}</p>
                        <span className="text-[11px] text-ink-subtle">{req.assetTag}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${priorityStyle[req.priority]}`}>
                          {req.priority}
                        </span>
                      </div>
                      <p className="text-xs text-ink-muted truncate">{req.issue}</p>
                      <p className="text-[11px] text-ink-faint mt-0.5 flex items-center gap-1">
                        <Calendar size={10} /> Raised {req.raisedOn}
                      </p>
                    </div>
                    <span className={`flex-shrink-0 text-[11px] font-semibold px-2 py-1 rounded-lg ${maintenanceStatusStyle[req.status]}`}>
                      {req.status}
                    </span>
                  </div>
                </motion.div>
              ))}

              {myMaint.length === 0 && (
                <div className="py-10 text-center text-ink-subtle text-xs">
                  <Wrench size={28} className="mx-auto mb-2 opacity-30" />
                  No maintenance requests raised.
                  <button onClick={() => onNavigate("maintenance")} className="block mx-auto mt-2 text-info hover:underline">
                    Raise a request &rarr;
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </div>

        {/* ── ROW 4: Recent Activity ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.52, type: "spring" as const, stiffness: 100 }}
          className="bg-surface border border-line rounded-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <div className="flex items-center gap-2">
              <Activity size={15} className="text-info" />
              <h2 className="text-sm font-semibold text-ink">My Recent Activity</h2>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-line">
            {activity.map((item, i) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.54 + i * 0.04 }}
                className="px-5 py-4 flex items-start gap-3 hover:bg-surface-3 transition-colors"
              >
                <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${statusDot[item.status]}`} />
                <div>
                  <p className="text-xs text-ink-soft leading-snug">{item.text}</p>
                  <p className="text-[10px] text-ink-faint mt-0.5">{item.time}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* ── INFO NOTICE ── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="flex items-start gap-3 bg-info/8 border border-info/20 rounded-2xl px-5 py-3"
        >
          <Info size={15} className="text-info flex-shrink-0 mt-0.5" />
          <p className="text-xs text-info/80 leading-relaxed">
            You are viewing your <span className="font-semibold text-info">personal portal</span>. Only assets, bookings, and requests associated with your account are shown here.
            To report issues or request new equipment, use the Quick Actions above or contact your Asset Manager.
          </p>
        </motion.div>

        <div className="text-center text-[11px] text-ink pb-2">
          AssetFlow ERP &middot; Employee Portal &middot; Last updated {lastUpdated.toLocaleTimeString()}
        </div>
      </div>

      {/* Cancelling a booking — ask first */}
      <ConfirmDialog
        open={!!cancelTarget}
        title="Cancel this booking?"
        message={
          cancelTarget
            ? `${cancelTarget.resource} will be free again for others. You can book it again later if you change your mind.`
            : ""
        }
        confirmLabel="Cancel booking"
        destructive
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          if (!cancelTarget) return;
          const id = cancelTarget.id;
          setCancelTarget(null);
          void handleCancelBooking(id);
        }}
      />
    </div>
  );
};

export default EmployeeDashboard;
