import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ClipboardCheck,
  Search,
  Plus,
  Calendar,
  Users,
  MapPin,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Lock,
  ArrowRight,
  AlertCircle,
  X,
  Loader2,
  Building2,
} from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import { getSession } from "@/lib/auth";

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const cardVariants = {
  hidden: {
    opacity: 0,
    y: 20,
    scale: 0.95,
  },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: "spring" as const, stiffness: 300, damping: 24 },
  },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } },
};

interface AuditProgress {
  total: number;
  verified: number;
  missing: number;
  damaged: number;
}

interface AuditCycle {
  id: string;
  title: string;
  scope: string;
  startDate: string;
  endDate: string;
  status: string;
  progress: AuditProgress;
  auditors: string[];
}

const getStatusStyles = (status: string) => {
  switch (status?.toLowerCase()) {
    case "in progress":
      return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    case "completed":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
    case "draft":
      return "bg-gray-500/10 text-gray-400 border-gray-500/20";
    default:
      return "bg-gray-500/10 text-gray-400 border-gray-500/20";
  }
};

export default function AssetAudits() {
  const [audits, setAudits] = useState<AuditCycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const [createForm, setCreateForm] = useState({
    name: "", scopeLocation: "", startDate: "", endDate: "",
  });

  const session = getSession();
  const isAdmin = session?.user?.role === "ADMIN";

  // ==========================================
  // BACKEND INTEGRATION: Fetch Audit Cycles
  // ==========================================
  const fetchAudits = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await apiGet<{ items: Array<Record<string, any>> }>("/audits");
      const mapped: AuditCycle[] = (data.items ?? []).map((c: any) => ({
        id: c.id,
        title: c.name,
        scope:
          c.scopeLocation ??
          c.scopeDepartment?.name ??
          "All assets",
        startDate: c.startDate ? c.startDate.slice(0, 10) : "",
        endDate: c.endDate ? c.endDate.slice(0, 10) : "",
        status: c.status === "CLOSED" ? "Completed" : "In Progress",
        progress: {
          total: c.counts?.total ?? 0,
          verified: c.counts?.verified ?? 0,
          missing: c.counts?.missing ?? 0,
          damaged: c.counts?.damaged ?? 0,
        },
        auditors: [],
      }));
      setAudits(mapped);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load audit cycles."
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudits();
  }, [fetchAudits]);

  // ── Create audit cycle — real POST /audits, real error handling ──
  const handleCreateAudit = async () => {
    const e: Record<string, string> = {};
    if (!createForm.name.trim()) e.name = "Audit name is required";
    if (!createForm.startDate) e.startDate = "Start date is required";
    if (!createForm.endDate) e.endDate = "End date is required";
    if (createForm.startDate && createForm.endDate && createForm.endDate < createForm.startDate)
      e.endDate = "End date must be after start date";
    if (Object.keys(e).length) { setCreateErrors(e); return; }

    setCreating(true);
    try {
      await apiSend("/audits", "POST", {
        name: createForm.name.trim(),
        scopeLocation: createForm.scopeLocation.trim() || undefined,
        startDate: createForm.startDate,
        endDate: createForm.endDate,
      });
      setShowCreate(false);
      setCreateForm({ name: "", scopeLocation: "", startDate: "", endDate: "" });
      setCreateErrors({});
      fetchAudits();
    } catch (err: any) {
      setCreateErrors({ submit: err?.message ?? "Failed to create audit cycle." });
    } finally {
      setCreating(false);
    }
  };

  // ==========================================
  // FILTERING LOGIC
  // ==========================================
  const filteredAudits = audits.filter((audit) => {
    const matchesSearch =
      audit.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      audit.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      audit.scope.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTab =
      activeTab === "All"
        ? true
        : audit.status.toLowerCase() === activeTab.toLowerCase();
    return matchesSearch && matchesTab;
  });

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
            Asset Audits
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Schedule verification cycles and manage discrepancies.
          </p>
        </div>
        <motion.button
          whileHover={isAdmin ? { scale: 1.02 } : undefined}
          whileTap={isAdmin ? { scale: 0.98 } : undefined}
          onClick={() => isAdmin && setShowCreate(true)}
          disabled={!isAdmin}
          title={isAdmin ? "Create Audit Cycle" : "Only Admins can create audit cycles"}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${isAdmin ? "bg-blue-600 hover:bg-blue-700 text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]" : "bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700"}`}
        >
          {isAdmin ? <Plus size={18} /> : <Lock size={15} />}
          {isAdmin ? "Create Audit Cycle" : "Admins Only"}
        </motion.button>
      </div>

      {/* --- Filters & Search Toolbar --- */}
      <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="flex p-1 bg-[#161925] border border-zinc-800/80 rounded-xl w-full lg:w-auto overflow-x-auto">
          {["All", "In Progress", "Draft", "Completed"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`whitespace-nowrap px-6 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab
                  ? "bg-zinc-800 text-white shadow-sm"
                  : "text-gray-400 hover:text-gray-200 hover:bg-zinc-800/50"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-80">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
            size={16}
          />
          <input
            type="text"
            placeholder="Search audits by title, ID, or scope..."
            className="w-full bg-[#161925] border border-zinc-800/80 text-white text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* --- Error State --- */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-4 text-red-400">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="ml-auto underline text-sm hover:text-red-300"
          >
            Retry Fetch
          </button>
        </div>
      )}

      {/* --- Loading Skeletons --- */}
      {isLoading && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map((n) => (
            <div
              key={n}
              className="bg-[#161925] border border-zinc-800 rounded-2xl p-6 h-64 animate-pulse flex flex-col justify-between"
            >
              <div className="space-y-4">
                <div className="flex justify-between">
                  <div className="h-6 bg-zinc-800 rounded w-1/2"></div>
                  <div className="h-6 bg-zinc-800 rounded-full w-24"></div>
                </div>
                <div className="h-4 bg-zinc-800 rounded w-1/3"></div>
                <div className="h-12 bg-[#0f111a] rounded-xl w-full mt-4"></div>
              </div>
              <div className="flex gap-3 mt-4 border-t border-zinc-800/50 pt-4">
                <div className="h-10 bg-zinc-800 rounded-lg w-full"></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* --- Data Grid --- */}
      {!isLoading && !error && (
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 lg:grid-cols-2 gap-6"
        >
          <AnimatePresence>
            {filteredAudits.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="col-span-full flex flex-col items-center justify-center py-20 text-gray-500"
              >
                <ClipboardCheck size={48} className="mb-4 opacity-20" />
                <p>No audit cycles found.</p>
              </motion.div>
            ) : (
              filteredAudits.map((audit) => {
                const isCompleted = audit.status === "Completed";
                const progressPercentage =
                  audit.progress.total > 0
                    ? Math.round(
                        (audit.progress.verified / audit.progress.total) * 100
                      )
                    : 0;
                const hasDiscrepancies =
                  audit.progress.missing > 0 || audit.progress.damaged > 0;

                return (
                  <motion.div
                    key={audit.id}
                    variants={cardVariants}
                    layout
                    className="relative overflow-hidden bg-[#161925] border border-zinc-800/80 hover:border-zinc-700 rounded-2xl p-6 shadow-xl flex flex-col justify-between group transition-colors"
                  >
                    {/* Subtle Background Glow based on Status */}
                    <div
                      className={`absolute -top-10 -right-10 w-40 h-40 blur-[60px] opacity-10 rounded-full pointer-events-none transition-colors ${
                        isCompleted
                          ? "bg-emerald-500"
                          : audit.status === "In Progress"
                          ? "bg-blue-500"
                          : "bg-gray-500"
                      }`}
                    ></div>

                    <div>
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h3 className="text-lg font-bold text-gray-100 group-hover:text-blue-400 transition-colors line-clamp-1">
                            {audit.title}
                          </h3>
                          <p className="text-xs text-zinc-500 font-mono mt-1">
                            {audit.id}
                          </p>
                        </div>

                        <span
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${getStatusStyles(audit.status)}`}
                        >
                          {isCompleted && <CheckCircle2 size={12} />}
                          {audit.status}
                        </span>
                      </div>

                      {/* Info Pills */}
                      <div className="flex flex-wrap gap-3 mt-4">
                        <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-[#0f111a] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                          <MapPin size={12} className="text-zinc-500" />{" "}
                          {audit.scope}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-[#0f111a] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                          <Calendar size={12} className="text-zinc-500" />{" "}
                          {audit.startDate} to {audit.endDate}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-[#0f111a] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                          <Users size={12} className="text-zinc-500" />
                          {audit.auditors.length}{" "}
                          {audit.auditors.length === 1
                            ? "Auditor"
                            : "Auditors"}
                        </div>
                      </div>

                      {/* Progress Section */}
                      <div className="mt-6 p-4 rounded-xl border border-zinc-800/50 bg-[#0f111a]">
                        <div className="flex justify-between items-end mb-2">
                          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                            Audit Progress
                          </span>
                          <span className="text-sm font-bold text-white">
                            {progressPercentage}%
                          </span>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full bg-zinc-800 rounded-full h-2 mb-4 overflow-hidden flex">
                          <div
                            className="bg-blue-500 h-2 transition-all duration-1000"
                            style={{ width: `${progressPercentage}%` }}
                          ></div>
                        </div>

                        {/* Stat Counters */}
                        <div className="grid grid-cols-3 gap-2 text-center divide-x divide-zinc-800">
                          <div>
                            <p className="text-xs text-zinc-500">
                              Total / Scanned
                            </p>
                            <p className="text-sm font-bold text-gray-200 mt-0.5">
                              {audit.progress.total} / {audit.progress.verified}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-zinc-500">Missing</p>
                            <p
                              className={`text-sm font-bold mt-0.5 ${
                                audit.progress.missing > 0
                                  ? "text-red-400"
                                  : "text-gray-400"
                              }`}
                            >
                              {audit.progress.missing}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-zinc-500">Damaged</p>
                            <p
                              className={`text-sm font-bold mt-0.5 ${
                                audit.progress.damaged > 0
                                  ? "text-amber-400"
                                  : "text-gray-400"
                              }`}
                            >
                              {audit.progress.damaged}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Discrepancy Warning */}
                      {hasDiscrepancies && !isCompleted && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg border border-amber-500/20">
                          <AlertTriangle size={14} />
                          Discrepancies found! Review required before closing
                          cycle.
                        </div>
                      )}
                    </div>

                    {/* Action Buttons based on Status */}
                    <div className="mt-6 pt-4 border-t border-zinc-800/50 flex gap-3">
                      {audit.status === "Draft" && (
                        <button className="w-full bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 border border-blue-500/20 py-2.5 rounded-xl text-xs font-semibold transition-colors flex justify-center items-center gap-2">
                          Start Audit Cycle <ArrowRight size={14} />
                        </button>
                      )}

                      {audit.status === "In Progress" && (
                        <>
                          <button className="flex-1 bg-blue-600 text-white hover:bg-blue-700 py-2.5 rounded-xl text-xs font-semibold transition-colors shadow-lg shadow-blue-900/20 flex justify-center items-center gap-2">
                            <ClipboardCheck size={14} /> Continue Audit
                          </button>
                          <button className="flex-[0.6] bg-zinc-800 hover:bg-zinc-700 text-gray-300 border border-zinc-700 py-2.5 rounded-xl text-xs font-semibold transition-colors flex justify-center items-center gap-2">
                            <Lock size={14} /> Close Cycle
                          </button>
                        </>
                      )}

                      {isCompleted && (
                        <button className="w-full bg-[#0f111a] hover:bg-zinc-800 border border-zinc-800 text-gray-300 py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-2">
                          <FileText size={14} /> View Discrepancy Report
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* ── Create Audit Cycle Modal ── */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
            onClick={() => setShowCreate(false)}
          >
            <motion.div
              initial={{ scale: 0.93, opacity: 0, y: 24 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.93, opacity: 0, y: 24 }}
              transition={{ type: "spring", damping: 26, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[#1a1d2e] border border-zinc-700/80 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[95vh] flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-blue-500/15 flex items-center justify-center">
                    <ClipboardCheck size={18} className="text-blue-400" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-white">Create Audit Cycle</h2>
                    <p className="text-[11px] text-zinc-500">Schedule a new asset verification cycle</p>
                  </div>
                </div>
                <button onClick={() => setShowCreate(false)} className="p-1.5 rounded-lg hover:bg-zinc-700/50 transition-colors">
                  <X size={16} className="text-zinc-400" />
                </button>
              </div>

              {/* Body */}
              <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
                {!isAdmin && (
                  <div className="flex items-center gap-2 bg-amber-950/30 border border-amber-500/25 rounded-xl px-4 py-2.5 text-xs text-amber-300">
                    <AlertTriangle size={13} /> Only Admins can create audit cycles. Your session will be rejected by the server.
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">Audit Name <span className="text-red-400">*</span></label>
                  <input
                    value={createForm.name}
                    onChange={(e) => { setCreateForm((p) => ({ ...p, name: e.target.value })); setCreateErrors((p) => ({ ...p, name: "" })); }}
                    placeholder="e.g. Q3 IT Equipment Verification"
                    className={`w-full bg-[#0f111a] border rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors ${createErrors.name ? "border-red-500/60" : "border-zinc-700/80"}`}
                  />
                  {createErrors.name && <p className="text-red-400 text-[11px] mt-1">{createErrors.name}</p>}
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">Scope Location <span className="text-zinc-600">(optional)</span></label>
                  <div className="relative">
                    <Building2 size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                      value={createForm.scopeLocation}
                      onChange={(e) => setCreateForm((p) => ({ ...p, scopeLocation: e.target.value }))}
                      placeholder="e.g. HQ - Floor 2 (blank = all assets)"
                      className="w-full bg-[#0f111a] border border-zinc-700/80 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-400 mb-1.5">Start Date <span className="text-red-400">*</span></label>
                    <div className="relative">
                      <Calendar size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type="date"
                        value={createForm.startDate}
                        onChange={(e) => { setCreateForm((p) => ({ ...p, startDate: e.target.value })); setCreateErrors((p) => ({ ...p, startDate: "", endDate: "" })); }}
                        className={`w-full bg-[#0f111a] border rounded-xl pl-8 pr-2 py-2.5 text-sm text-white outline-none focus:border-blue-500/60 transition-colors [color-scheme:dark] ${createErrors.startDate ? "border-red-500/60" : "border-zinc-700/80"}`}
                      />
                    </div>
                    {createErrors.startDate && <p className="text-red-400 text-[11px] mt-1">{createErrors.startDate}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-400 mb-1.5">End Date <span className="text-red-400">*</span></label>
                    <div className="relative">
                      <Calendar size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type="date"
                        value={createForm.endDate}
                        min={createForm.startDate || undefined}
                        onChange={(e) => { setCreateForm((p) => ({ ...p, endDate: e.target.value })); setCreateErrors((p) => ({ ...p, endDate: "" })); }}
                        className={`w-full bg-[#0f111a] border rounded-xl pl-8 pr-2 py-2.5 text-sm text-white outline-none focus:border-blue-500/60 transition-colors [color-scheme:dark] ${createErrors.endDate ? "border-red-500/60" : "border-zinc-700/80"}`}
                      />
                    </div>
                    {createErrors.endDate && <p className="text-red-400 text-[11px] mt-1">{createErrors.endDate}</p>}
                  </div>
                </div>

                {createErrors.submit && (
                  <div className="flex items-center gap-2 bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-2.5 text-sm text-red-400">
                    <AlertCircle size={14} /> {createErrors.submit}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-zinc-800 flex gap-3 flex-shrink-0">
                <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all">
                  Cancel
                </button>
                <button
                  onClick={handleCreateAudit}
                  disabled={creating}
                  className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-blue-600/20"
                >
                  {creating ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><CheckCircle2 size={14} /> Create Cycle</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
