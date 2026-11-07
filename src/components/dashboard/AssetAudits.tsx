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
  AlertCircle,
  X,
  Loader2,
  Building2,
} from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { errorMessage } from "@/lib/utils";
import AuditCycleModal from "@/components/dashboard/AuditCycleModal";

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
      return "bg-info/10 text-info border-info/20";
    case "completed":
      return "bg-success/10 text-success border-success/20";
    case "draft":
      return "bg-ink-subtle/10 text-ink-muted border-line-strong/20";
    default:
      return "bg-ink-subtle/10 text-ink-muted border-line-strong/20";
  }
};

export default function AssetAudits() {
  const [audits, setAudits] = useState<AuditCycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState("All");
  /*
   * The three buttons at the bottom of each card used to have no handler at
   * all. They now do what they say:
   *   Continue Audit          → open the items, each one markable
   *   View Discrepancy Report → open the MISSING / DAMAGED items
   *   Close Cycle             → POST /audits/:id/close (two-step, because it
   *                             locks the cycle and rewrites asset statuses)
   */
  const [cycleView, setCycleView] = useState<{
    id: string;
    title: string;
    mode: "items" | "discrepancies";
    readOnly: boolean;
  } | null>(null);
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
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
  interface RawAuditCycle {
  id: string;
  name?: string;
  scopeLocation?: string;
  scopeDepartment?: { name?: string } | null;
  startDate?: string;
  endDate?: string;
  status?: string;
  counts?: {
    total?: number;
    verified?: number;
    missing?: number;
    damaged?: number;
  };
}

const fetchAudits = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await apiGet<{ items: RawAuditCycle[] }>("/audits");
      const mapped: AuditCycle[] = (data.items ?? []).map((c) => ({
        id: c.id,
        title: c.name ?? "Audit cycle",
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
    void fetchAudits();
  }, [fetchAudits]);

  /**
   * POST /audits/:id/close — locks the cycle and rewrites the assets that were
   * found missing or damaged. Destructive, so the button asks twice.
   */
  const handleCloseCycle = async (id: string) => {
    setClosingId(id);
    setError(null);
    try {
      await apiSend(`/audits/${id}/close`, "POST");
      setConfirmCloseId(null);
      await fetchAudits();
    } catch (err) {
      setError(errorMessage(err, "Could not close this audit cycle."));
    } finally {
      setClosingId(null);
    }
  };

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
      void fetchAudits();
    } catch (err) {
      setCreateErrors({ submit: errorMessage(err, "Failed to create audit cycle.") });
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
          <h1 className="text-2xl font-bold text-ink tracking-tight">
            Asset Audits
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Schedule verification cycles and manage discrepancies.
          </p>
        </div>
        <motion.button
          whileHover={isAdmin ? { scale: 1.02 } : undefined}
          whileTap={isAdmin ? { scale: 0.98 } : undefined}
          onClick={() => isAdmin && setShowCreate(true)}
          disabled={!isAdmin}
          title={isAdmin ? "Create Audit Cycle" : "Only Admins can create audit cycles"}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${isAdmin ? "bg-info hover:bg-info text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]" : "bg-surface-3 text-ink-subtle cursor-not-allowed border border-line"}`}
        >
          {isAdmin ? <Plus size={18} /> : <Lock size={15} />}
          {isAdmin ? "Create Audit Cycle" : "Admins Only"}
        </motion.button>
      </div>

      {/* --- Filters & Search Toolbar --- */}
      <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="flex p-1 bg-surface-2 border border-line/80 rounded-xl w-full lg:w-auto overflow-x-auto">
          {["All", "In Progress", "Draft", "Completed"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`whitespace-nowrap px-6 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab
                  ? "bg-surface-3 text-ink shadow-sm"
                  : "text-ink-muted hover:text-ink hover:bg-surface-3/50"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-80">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
            size={16}
          />
          <input
            type="text"
            placeholder="Search audits by title, ID, or scope..."
            className="w-full bg-surface-2 border border-line/80 text-ink text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:border-info/50 focus:ring-1 focus:ring-info/50 transition-all placeholder:text-ink-faint"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* --- Error State --- */}
      {error && (
        <div role="alert" className="bg-danger/10 border border-danger/20 rounded-xl p-4 flex items-center gap-4 text-danger">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="ml-auto underline text-sm hover:text-danger"
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
              className="bg-surface-2 border border-line rounded-2xl p-6 h-64 animate-pulse flex flex-col justify-between"
            >
              <div className="space-y-4">
                <div className="flex justify-between">
                  <div className="h-6 bg-surface-3 rounded w-1/2"></div>
                  <div className="h-6 bg-surface-3 rounded-full w-24"></div>
                </div>
                <div className="h-4 bg-surface-3 rounded w-1/3"></div>
                <div className="h-12 bg-canvas rounded-xl w-full mt-4"></div>
              </div>
              <div className="flex gap-3 mt-4 border-t border-line/50 pt-4">
                <div className="h-10 bg-surface-3 rounded-lg w-full"></div>
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
                className="col-span-full flex flex-col items-center justify-center py-20 text-ink-subtle"
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
                    className="relative overflow-hidden bg-surface-2 border border-line/80 hover:border-line rounded-2xl p-6 shadow-xl flex flex-col justify-between group transition-colors"
                  >
                    {/* Subtle Background Glow based on Status */}
                    <div
                      className={`absolute -top-10 -right-10 w-40 h-40 blur-[60px] opacity-10 rounded-full pointer-events-none transition-colors ${
                        isCompleted
                          ? "bg-success"
                          : audit.status === "In Progress"
                          ? "bg-info"
                          : "bg-ink-subtle"
                      }`}
                    ></div>

                    <div>
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h3 className="text-lg font-bold text-ink group-hover:text-info transition-colors line-clamp-1">
                            {audit.title}
                          </h3>
                          <p className="text-xs text-ink-subtle font-mono mt-1">
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
                        <div className="flex items-center gap-1.5 text-xs text-ink-muted bg-canvas px-2.5 py-1.5 rounded-lg border border-line">
                          <MapPin size={12} className="text-ink-subtle" />{" "}
                          {audit.scope}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-ink-muted bg-canvas px-2.5 py-1.5 rounded-lg border border-line">
                          <Calendar size={12} className="text-ink-subtle" />{" "}
                          {audit.startDate} to {audit.endDate}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-ink-muted bg-canvas px-2.5 py-1.5 rounded-lg border border-line">
                          <Users size={12} className="text-ink-subtle" />
                          {audit.auditors.length}{" "}
                          {audit.auditors.length === 1
                            ? "Auditor"
                            : "Auditors"}
                        </div>
                      </div>

                      {/* Progress Section */}
                      <div className="mt-6 p-4 rounded-xl border border-line/50 bg-canvas">
                        <div className="flex justify-between items-end mb-2">
                          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
                            Audit Progress
                          </span>
                          <span className="text-sm font-bold text-ink">
                            {progressPercentage}%
                          </span>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full bg-surface-3 rounded-full h-2 mb-4 overflow-hidden flex">
                          <div
                            className="bg-info h-2 transition-all duration-1000"
                            style={{ width: `${progressPercentage}%` }}
                          ></div>
                        </div>

                        {/* Stat Counters */}
                        <div className="grid grid-cols-3 gap-2 text-center divide-x divide-line">
                          <div>
                            <p className="text-xs text-ink-subtle">
                              Total / Scanned
                            </p>
                            <p className="text-sm font-bold text-ink mt-0.5">
                              {audit.progress.total} / {audit.progress.verified}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-ink-subtle">Missing</p>
                            <p
                              className={`text-sm font-bold mt-0.5 ${
                                audit.progress.missing > 0
                                  ? "text-danger"
                                  : "text-ink-muted"
                              }`}
                            >
                              {audit.progress.missing}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-ink-subtle">Damaged</p>
                            <p
                              className={`text-sm font-bold mt-0.5 ${
                                audit.progress.damaged > 0
                                  ? "text-warning"
                                  : "text-ink-muted"
                              }`}
                            >
                              {audit.progress.damaged}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Discrepancy Warning */}
                      {hasDiscrepancies && !isCompleted && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-warning bg-warning/10 px-3 py-2 rounded-lg border border-warning/20">
                          <AlertTriangle size={14} />
                          Discrepancies found! Review required before closing
                          cycle.
                        </div>
                      )}
                    </div>

                    {/* Action Buttons based on Status.
                        There is no "Draft" state in the database (a cycle is
                        OPEN or CLOSED), so the branch that offered a "Start
                        Audit Cycle" button — which no endpoint could honour —
                        is gone rather than left unreachable. */}
                    <div className="mt-6 pt-4 border-t border-line/50 flex gap-3">
                      {!isCompleted && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setCycleView({
                                id: audit.id,
                                title: audit.title,
                                mode: "items",
                                readOnly: false,
                              })
                            }
                            className="flex-1 bg-info text-white hover:bg-info py-2.5 rounded-xl text-xs font-semibold transition-colors shadow-lg shadow-blue-900/20 flex justify-center items-center gap-2"
                          >
                            <ClipboardCheck size={14} /> Continue Audit
                          </button>
                          <button
                            type="button"
                            disabled={closingId === audit.id}
                            onClick={() => {
                              if (confirmCloseId !== audit.id) {
                                setConfirmCloseId(audit.id);
                                return;
                              }
                              void handleCloseCycle(audit.id);
                            }}
                            className="flex-[0.6] bg-surface-3 hover:bg-surface-3 text-ink-soft border border-line py-2.5 rounded-xl text-xs font-semibold transition-colors flex justify-center items-center gap-2 disabled:opacity-60"
                          >
                            {closingId === audit.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Lock size={14} />
                            )}
                            {confirmCloseId === audit.id
                              ? "Confirm close?"
                              : "Close Cycle"}
                          </button>
                        </>
                      )}

                      {isCompleted && (
                        <button
                          type="button"
                          onClick={() =>
                            setCycleView({
                              id: audit.id,
                              title: audit.title,
                              mode: "discrepancies",
                              readOnly: true,
                            })
                          }
                          className="w-full bg-canvas hover:bg-surface-3 border border-line text-ink-soft py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-2"
                        >
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
              className="bg-surface border border-line/80 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[95vh] flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-line flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-info/15 flex items-center justify-center">
                    <ClipboardCheck size={18} className="text-info" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-ink">Create Audit Cycle</h2>
                    <p className="text-[11px] text-ink-subtle">Schedule a new asset verification cycle</p>
                  </div>
                </div>
                <button onClick={() => setShowCreate(false)} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
                  <X size={16} className="text-ink-muted" />
                </button>
              </div>

              {/* Body */}
              <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
                {!isAdmin && (
                  <div className="flex items-center gap-2 bg-warning/8 border border-warning/25 rounded-xl px-4 py-2.5 text-xs text-warning">
                    <AlertTriangle size={13} /> Only Admins can create audit cycles. Your session will be rejected by the server.
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5">Audit Name <span className="text-danger">*</span></label>
                  <input
                    value={createForm.name}
                    onChange={(e) => { setCreateForm((p) => ({ ...p, name: e.target.value })); setCreateErrors((p) => ({ ...p, name: "" })); }}
                    placeholder="e.g. Q3 IT Equipment Verification"
                    className={`w-full bg-canvas border rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-info/60 transition-colors ${createErrors.name ? "border-danger/60" : "border-line/80"}`}
                  />
                  {createErrors.name && <p className="text-danger text-[11px] mt-1">{createErrors.name}</p>}
                </div>

                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5">Scope Location <span className="text-ink-faint">(optional)</span></label>
                  <div className="relative">
                    <Building2 size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                    <input
                      value={createForm.scopeLocation}
                      onChange={(e) => setCreateForm((p) => ({ ...p, scopeLocation: e.target.value }))}
                      placeholder="e.g. HQ - Floor 2 (blank = all assets)"
                      className="w-full bg-canvas border border-line/80 rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-info/60 transition-colors"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1.5">Start Date <span className="text-danger">*</span></label>
                    <div className="relative">
                      <Calendar size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                      <input
                        type="date"
                        value={createForm.startDate}
                        onChange={(e) => { setCreateForm((p) => ({ ...p, startDate: e.target.value })); setCreateErrors((p) => ({ ...p, startDate: "", endDate: "" })); }}
                        className={`w-full bg-canvas border rounded-xl pl-8 pr-2 py-2.5 text-sm text-ink outline-none focus:border-info/60 transition-colors [color-scheme:dark] ${createErrors.startDate ? "border-danger/60" : "border-line/80"}`}
                      />
                    </div>
                    {createErrors.startDate && <p className="text-danger text-[11px] mt-1">{createErrors.startDate}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1.5">End Date <span className="text-danger">*</span></label>
                    <div className="relative">
                      <Calendar size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                      <input
                        type="date"
                        value={createForm.endDate}
                        min={createForm.startDate || undefined}
                        onChange={(e) => { setCreateForm((p) => ({ ...p, endDate: e.target.value })); setCreateErrors((p) => ({ ...p, endDate: "" })); }}
                        className={`w-full bg-canvas border rounded-xl pl-8 pr-2 py-2.5 text-sm text-ink outline-none focus:border-info/60 transition-colors [color-scheme:dark] ${createErrors.endDate ? "border-danger/60" : "border-line/80"}`}
                      />
                    </div>
                    {createErrors.endDate && <p className="text-danger text-[11px] mt-1">{createErrors.endDate}</p>}
                  </div>
                </div>

                {createErrors.submit && (
                  <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-xl px-4 py-2.5 text-sm text-danger">
                    <AlertCircle size={14} /> {createErrors.submit}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-line flex gap-3 flex-shrink-0">
                <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all">
                  Cancel
                </button>
                <button
                  onClick={handleCreateAudit}
                  disabled={creating}
                  className="flex-1 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-blue-600/20"
                >
                  {creating ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><CheckCircle2 size={14} /> Create Cycle</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The cycle detail panel, opened by "Continue Audit" / "View
          Discrepancy Report" (see AuditCycleModal.tsx). */}
      {cycleView && (
        <AuditCycleModal
          cycleId={cycleView.id}
          title={cycleView.title}
          mode={cycleView.mode}
          readOnly={cycleView.readOnly}
          onClose={() => setCycleView(null)}
          onChanged={() => void fetchAudits()}
        />
      )}
    </motion.div>
  );
}
