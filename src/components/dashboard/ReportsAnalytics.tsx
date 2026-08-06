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
        const data = await apiGet<AnalyticsData>("/reports/analytics");
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

    fetchAnalytics();
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

  // Custom Tooltip for Recharts (Dark Mode Native)
  const CustomTooltip = ({
    active,
    payload,
    label,
    suffix = "",
  }: {
    active?: boolean;
    payload?: Array<{ value: number }>;
    label?: string;
    suffix?: string;
  }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[#161925] border border-zinc-800 p-3 rounded-lg shadow-xl">
          <p className="text-gray-400 text-xs mb-1 font-semibold">{label}</p>
          <p className="text-white font-bold text-sm">
            {payload[0].value}
            {suffix}
          </p>
        </div>
      );
    }
    return null;
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
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Reports & Analytics
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Actionable insights into asset utilization and organizational
            efficiency.
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleExport}
          className="flex items-center gap-2 bg-[#161925] border border-zinc-700 hover:bg-zinc-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-lg transition-all"
        >
          <Download size={18} />
          Export CSV Report
        </motion.button>
      </div>

      {/* --- Filters --- */}
      <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="flex p-1 bg-[#161925] border border-zinc-800/80 rounded-xl w-full lg:w-auto overflow-x-auto">
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
                  ? "bg-zinc-800 text-white shadow-sm"
                  : "text-gray-400 hover:text-gray-200 hover:bg-zinc-800/50"
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* --- Error State --- */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-4 text-red-400">
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
                className="h-28 bg-[#161925] rounded-2xl border border-zinc-800 animate-pulse"
              ></div>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="h-80 bg-[#161925] rounded-2xl border border-zinc-800 animate-pulse lg:col-span-2"></div>
            <div className="h-80 bg-[#161925] rounded-2xl border border-zinc-800 animate-pulse"></div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80 bg-[#161925] rounded-2xl border border-zinc-800 animate-pulse"></div>
            <div className="h-80 bg-[#161925] rounded-2xl border border-zinc-800 animate-pulse"></div>
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
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-blue-500/10 rounded-full blur-2xl group-hover:bg-blue-500/20 transition-all"></div>
              <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">
                Total Assets
              </p>
              <h3 className="text-3xl font-bold text-white">
                {analyticsData.kpis.totalAssets}
              </h3>
            </motion.div>

            <motion.div
              variants={itemVariants}
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl group-hover:bg-emerald-500/20 transition-all"></div>
              <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">
                Overall Utilization
              </p>
              <div className="flex items-end gap-2">
                <h3 className="text-3xl font-bold text-emerald-400">
                  {analyticsData.kpis.utilizationRate}%
                </h3>
                <TrendingUp size={20} className="text-emerald-500 mb-1" />
              </div>
            </motion.div>

            <motion.div
              variants={itemVariants}
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl group-hover:bg-amber-500/20 transition-all"></div>
              <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">
                Pending Maintenance
              </p>
              <h3 className="text-3xl font-bold text-amber-400">
                {analyticsData.kpis.maintenancePending}
              </h3>
            </motion.div>

            <motion.div
              variants={itemVariants}
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 bg-purple-500/10 rounded-full blur-2xl group-hover:bg-purple-500/20 transition-all"></div>
              <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">
                Active Bookings
              </p>
              <h3 className="text-3xl font-bold text-purple-400">
                {analyticsData.kpis.activeBookings}
              </h3>
            </motion.div>
          </div>

          {/* Charts Row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Utilization Trend Area Chart */}
            <motion.div
              variants={itemVariants}
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl lg:col-span-2"
            >
              <div className="flex items-center gap-2 mb-6">
                <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
                  <Activity size={18} />
                </div>
                <h3 className="text-lg font-semibold text-white">
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
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
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
                      tick={{ fill: "#9ca3af", fontSize: 12 }}
                      dy={10}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#9ca3af", fontSize: 12 }}
                    />
                    <Tooltip content={<CustomTooltip suffix="%" />} />
                    <Area
                      type="monotone"
                      dataKey="rate"
                      stroke="#3b82f6"
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
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg">
                  <PieChart size={18} />
                </div>
                <h3 className="text-lg font-semibold text-white">
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
                    <Tooltip content={<CustomTooltip />} />
                  </RechartsPie>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-2">
                  <span className="text-2xl font-bold text-white">
                    {analyticsData.kpis.totalAssets}
                  </span>
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">
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
                    <span className="text-gray-400">{stat.name}</span>
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
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl"
            >
              <div className="flex items-center gap-2 mb-6">
                <div className="p-2 bg-purple-500/10 text-purple-400 rounded-lg">
                  <BarChart2 size={18} />
                </div>
                <h3 className="text-lg font-semibold text-white">
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
                      tick={{ fill: "#9ca3af", fontSize: 12 }}
                    />
                    <YAxis
                      dataKey="dept"
                      type="category"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#d1d5db", fontSize: 12 }}
                    />
                    <Tooltip
                      content={<CustomTooltip />}
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
              className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-6 shadow-xl flex flex-col"
            >
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-amber-500/10 text-amber-400 rounded-lg">
                    <Calendar size={18} />
                  </div>
                  <h3 className="text-lg font-semibold text-white">
                    Resource Booking Heatmap
                  </h3>
                </div>
                <span className="text-xs text-gray-500">
                  Peak Usage Windows
                </span>
              </div>

              <div className="flex-1 flex flex-col justify-center">
                <div className="flex">
                  {/* Y-axis Labels (Days) */}
                  <div className="flex flex-col justify-between pr-4 py-2 border-r border-zinc-800">
                    {["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => (
                      <span
                        key={day}
                        className="text-xs text-gray-400 font-medium"
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
                              className="w-full aspect-square rounded-sm bg-blue-500 transition-opacity hover:opacity-100 cursor-crosshair"
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
                    <span key={time} className="text-[10px] text-gray-500">
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
