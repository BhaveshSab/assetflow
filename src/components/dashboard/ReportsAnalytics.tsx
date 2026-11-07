import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Download,
  TrendingUp,
  PieChart,
  BarChart2,
  Activity,
  AlertCircle,
  Calendar,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart as RechartsPie,
  Pie,
  Cell,
} from "recharts";
import { apiGet, authHeaders, BASE_URL } from "@/lib/api";

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 300, damping: 24 },
  },
};

interface KPIs {
  totalAssets: number;
  utilizationRate: number;
  maintenancePending: number;
  activeBookings: number;
}

interface TrendPoint {
  month: string;
  rate: number;
}

interface DeptAllocation {
  dept: string;
  count: number;
}

interface AssetStatus {
  name: string;
  value: number;
  color: string;
}

interface HeatmapCell {
  day: string;
  hour: string;
  intensity: number;
}

interface AnalyticsData {
  kpis: KPIs;
  utilizationTrend: TrendPoint[];
  departmentAllocations: DeptAllocation[];
  assetStatus: AssetStatus[];
  bookingHeatmap: HeatmapCell[][];
}

/**
 * The chart tooltip.
 *
 * It used to be declared *inside* the component, so a new function was
 * created on every render — Recharts then treated it as a new component and
 * remounted the tooltip each time the page re-rendered. At module scope it
 * is created once.
 */
function ChartTooltip({
  active,
  payload,
  label,
  suffix = "",
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  suffix?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-surface-2 border border-line p-3 rounded-lg shadow-xl">
      <p className="text-ink-muted text-xs mb-1 font-semibold">{label}</p>
      <p className="text-ink font-bold text-sm">
        {payload[0].value}
        {suffix}
      </p>
    </div>
  );
}

/** The range buttons' labels and the window each one asks the API for. */
const RANGE_PARAM: Record<string, string> = {
  "Last 30 Days": "30d",
  "Last 6 Months": "6m",
  "Year to Date": "ytd",
  "All Time": "all",
};

export default function ReportsAnalytics() {
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("Last 6 Months");

  // ==========================================
  // BACKEND INTEGRATION: Fetch Analytics Data
  // ==========================================
  useEffect(() => {
    const fetchAnalytics = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const data = await apiGet<AnalyticsData>(
          `/reports/analytics?range=${RANGE_PARAM[timeRange] ?? "6m"}`
        );
        setAnalyticsData(data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load analytics dashboard."
        );
      } finally {
        setIsLoading(false);
      }
    };

    void fetchAnalytics();
  }, [timeRange]);

  // ── Export: download the real asset CSV from the backend ──
  const handleExport = async () => {
    try {
      const res = await fetch(`${BASE_URL}/reports/export/assets.csv`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `assetflow-assets-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed. Is the backend running?");
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full space-y-8"
    >
      {/* --- Page Header --- */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight">
            Reports & Analytics
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Actionable insights into asset utilization and organizational
            efficiency.
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleExport}
          className="flex items-center gap-2 bg-surface-2 border border-line hover:bg-surface-3 text-ink px-5 py-2.5 rounded-xl text-sm font-medium shadow-lg transition-all"
        >
          <Download size={18} />
          Export CSV Report
        </motion.button>
      </div>

      {/* --- Filters --- */}
      <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="flex p-1 bg-surface-2 border border-line/80 rounded-xl w-full lg:w-auto overflow-x-auto">
          {[
            "Last 30 Days",
            "Last 6 Months",
            "Year to Date",
            "All Time",
          ].map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`whitespace-nowrap px-6 py-2 rounded-lg text-sm font-medium transition-all ${
                timeRange === range
                  ? "bg-surface-3 text-ink shadow-sm"
                  : "text-ink-muted hover:text-ink hover:bg-surface-3/50"
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* --- Error State --- */}
      {error && (
        <div role="alert" className="bg-danger/10 border border-danger/20 rounded-xl p-4 flex items-center gap-4 text-danger">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* --- Loading Skeletons --- */}
      {isLoading && !error && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className="h-28 bg-surface-2 rounded-2xl border border-line animate-pulse"
              ></div>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="h-80 bg-surface-2 rounded-2xl border border-line animate-pulse lg:col-span-2"></div>
            <div className="h-80 bg-surface-2 rounded-2xl border border-line animate-pulse"></div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80 bg-surface-2 rounded-2xl border border-line animate-pulse"></div>
            <div className="h-80 bg-surface-2 rounded-2xl border border-line animate-pulse"></div>
          </div>
        </div>
      )}

      {/* --- Analytics Content --- */}
      {!isLoading && !error && analyticsData && (
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="space-y-6"
        >
          {/* KPI Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-info/10 rounded-full blur-2xl group-hover:bg-info/20 transition-all"></div>
              <p className="text-sm font-medium text-ink-muted uppercase tracking-wider mb-2">
                Total Assets
              </p>
              <h3 className="text-3xl font-bold text-ink">
                {analyticsData.kpis.totalAssets}
              </h3>
            </motion.div>

            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-success/10 rounded-full blur-2xl group-hover:bg-success/20 transition-all"></div>
              <p className="text-sm font-medium text-ink-muted uppercase tracking-wider mb-2">
                Overall Utilization
              </p>
              <div className="flex items-end gap-2">
                <h3 className="text-3xl font-bold text-success">
                  {analyticsData.kpis.utilizationRate}%
                </h3>
                <TrendingUp size={20} className="text-success mb-1" />
              </div>
            </motion.div>

            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-warning/10 rounded-full blur-2xl group-hover:bg-warning/20 transition-all"></div>
              <p className="text-sm font-medium text-ink-muted uppercase tracking-wider mb-2">
                Pending Maintenance
              </p>
              <h3 className="text-3xl font-bold text-warning">
                {analyticsData.kpis.maintenancePending}
              </h3>
            </motion.div>

            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-violet/10 rounded-full blur-2xl group-hover:bg-violet/20 transition-all"></div>
              <p className="text-sm font-medium text-ink-muted uppercase tracking-wider mb-2">
                Active Bookings
              </p>
              <h3 className="text-3xl font-bold text-violet">
                {analyticsData.kpis.activeBookings}
              </h3>
            </motion.div>
          </div>

          {/* Charts Row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Utilization Trend Area Chart */}
            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl lg:col-span-2"
            >
              <div className="flex items-center gap-2 mb-6">
                <div className="p-2 bg-info/10 text-info rounded-lg">
                  <Activity size={18} />
                </div>
                <h3 className="text-lg font-semibold text-ink">
                  Utilization Trend
                </h3>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={analyticsData.utilizationTrend}
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="colorRate"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="#27272a"
                    />
                    <XAxis
                      dataKey="month"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "hsl(var(--chart-tick))", fontSize: 12 }}
                      dy={10}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "hsl(var(--chart-tick))", fontSize: 12 }}
                    />
                    <Tooltip content={<ChartTooltip suffix="%" />} />
                    <Area
                      type="monotone"
                      dataKey="rate"
                      stroke="hsl(var(--chart-1))"
                      strokeWidth={3}
                      fillOpacity={1}
                      fill="url(#colorRate)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

            {/* Asset Status Donut Chart */}
            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="p-2 bg-success/10 text-success rounded-lg">
                  <PieChart size={18} />
                </div>
                <h3 className="text-lg font-semibold text-ink">
                  Status Breakdown
                </h3>
              </div>
              <div className="h-48 w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsPie>
                    <Pie
                      data={analyticsData.assetStatus}
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                      stroke="none"
                    >
                      {analyticsData.assetStatus.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={entry.color}
                        />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </RechartsPie>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-2">
                  <span className="text-2xl font-bold text-ink">
                    {analyticsData.kpis.totalAssets}
                  </span>
                  <span className="text-[10px] text-ink-subtle uppercase tracking-wider">
                    Assets
                  </span>
                </div>
              </div>

              {/* Custom Legend */}
              <div className="grid grid-cols-2 gap-3 mt-2">
                {analyticsData.assetStatus.map((stat, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: stat.color }}
                    ></div>
                    <span className="text-ink-muted">{stat.name}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Charts Row 2 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Department Allocations Bar Chart */}
            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl"
            >
              <div className="flex items-center gap-2 mb-6">
                <div className="p-2 bg-violet/10 text-violet rounded-lg">
                  <BarChart2 size={18} />
                </div>
                <h3 className="text-lg font-semibold text-ink">
                  Department Allocations
                </h3>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={analyticsData.departmentAllocations}
                    layout="vertical"
                    margin={{ top: 0, right: 10, left: 20, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      horizontal={true}
                      vertical={false}
                      stroke="#27272a"
                    />
                    <XAxis
                      type="number"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "hsl(var(--chart-tick))", fontSize: 12 }}
                    />
                    <YAxis
                      dataKey="dept"
                      type="category"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "hsl(var(--ink-soft))", fontSize: 12 }}
                    />
                    <Tooltip
                      content={<ChartTooltip />}
                      cursor={{ fill: "#27272a" }}
                    />
                    <Bar
                      dataKey="count"
                      fill="#8b5cf6"
                      radius={[0, 4, 4, 0]}
                      barSize={20}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

            {/* Booking Heatmap (Custom Grid) */}
            <motion.div
              variants={itemVariants}
              className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl flex flex-col"
            >
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-warning/10 text-warning rounded-lg">
                    <Calendar size={18} />
                  </div>
                  <h3 className="text-lg font-semibold text-ink">
                    Resource Booking Heatmap
                  </h3>
                </div>
                <span className="text-xs text-ink-subtle">
                  Peak Usage Windows
                </span>
              </div>

              <div className="flex-1 flex flex-col justify-center">
                <div className="flex">
                  {/* Y-axis Labels (Days) */}
                  <div className="flex flex-col justify-between pr-4 py-2 border-r border-line">
                    {["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => (
                      <span
                        key={day}
                        className="text-xs text-ink-muted font-medium"
                      >
                        {day}
                      </span>
                    ))}
                  </div>

                  {/* Heatmap Grid */}
                  <div className="flex-1 pl-4 flex flex-col justify-between">
                    {analyticsData.bookingHeatmap.map((dayData, dIdx) => (
                      <div key={dIdx} className="flex justify-between gap-1">
                        {dayData.map((hourData, hIdx) => {
                          const opacity = Math.max(
                            0.1,
                            hourData.intensity / 10
                          );
                          return (
                            <div
                              key={hIdx}
                              title={`${hourData.day} ${hourData.hour}: Activity Level ${hourData.intensity}`}
                              className="w-full aspect-square rounded-sm bg-info transition-opacity hover:opacity-100 cursor-crosshair"
                              style={{ opacity: opacity }}
                            ></div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {/* X-axis Labels (Hours) */}
                <div className="flex justify-between pl-12 pr-1 mt-3">
                  {["9A", "11A", "1P", "3P", "5P"].map((time) => (
                    <span key={time} className="text-[10px] text-ink-subtle">
                      {time}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
