import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Package, Tag, Calendar, AlertTriangle, CheckCircle2,
  Clock, Search, X, ArrowLeftRight, Info,
  Loader2, RefreshCw, BadgeCheck, MapPin, CornerUpLeft,
  AlertCircle, Check, Send,
} from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import { getSession } from "@/lib/auth";

// ── Condition options for the return flow ──
const RETURN_CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
  { value: "POOR", label: "Poor" },
  { value: "DAMAGED", label: "Damaged" },
] as const;

// ── Transfer modal (pick a coworker + reason, POST /transfers) ──
const TransferModal = ({
  open,
  asset,
  submitting,
  currentUserId,
  onClose,
  onConfirm,
}: {
  open: boolean;
  asset: MyAsset | null;
  submitting: boolean;
  currentUserId?: string;
  onClose: () => void;
  onConfirm: (toUserId: string, reason?: string) => void;
}) => {
  const [employees, setEmployees] = useState<
    Array<{ id: string; name: string; email: string }>
  >([]);
  const [loadingEmps, setLoadingEmps] = useState(false);
  const [empError, setEmpError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(null);
    setReason("");
    setEmpError("");
    setLoadingEmps(true);
    apiGet<Array<{ id: string; name: string; email: string }>>(
      "/org/employees/directory",
    )
      .then((data) =>
        setEmployees(
          (Array.isArray(data) ? data : []).filter((e) => e.id !== currentUserId),
        ),
      )
      .catch((err: any) => {
        setEmployees([]);
        setEmpError(err?.message ?? "Failed to load employees");
      })
      .finally(() => setLoadingEmps(false));
  }, [open, currentUserId]);

  if (!open || !asset) return null;

  const initials = (name: string) =>
    name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "—";

  const filtered = employees.filter(
    (e) =>
      e.name.toLowerCase().includes(query.toLowerCase()) ||
      e.email.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[150] flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.93, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.93, opacity: 0, y: 20 }}
          transition={{ type: "spring" as const, damping: 26, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-[#1a1d2e] border border-zinc-700/80 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-500/15 flex items-center justify-center">
                <ArrowLeftRight size={16} className="text-blue-400" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-white">Request Transfer</h2>
                <p className="text-[11px] text-zinc-500">
                  {asset.asset?.name} &middot; {asset.asset?.assetTag}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-700/50 transition-colors">
              <X size={15} className="text-zinc-400" />
            </button>
          </div>

          <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wide">
                Transfer to
              </label>
              <div className="relative mb-2">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search employees…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full bg-[#0f111a] border border-zinc-700/80 rounded-xl pl-9 pr-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-all"
                />
              </div>
              <div className="max-h-44 overflow-y-auto rounded-xl border border-zinc-800 divide-y divide-zinc-800/50">
                {loadingEmps ? (
                  <div className="py-6 flex items-center justify-center gap-2 text-zinc-500 text-sm">
                    <Loader2 size={14} className="animate-spin text-blue-400" />
                    Loading employees…
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="py-6 text-center text-zinc-600 text-sm">
                    {empError
                      ? empError
                      : employees.length === 0
                        ? "No other employees found"
                        : "No match — try a different name"}
                  </div>
                ) : (
                  filtered.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors ${
                        selected === e.id ? "bg-blue-500/10" : "hover:bg-zinc-800/50"
                      }`}
                    >
                      <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">
                        {initials(e.name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{e.name}</p>
                        <p className="text-[11px] text-zinc-500 truncate">{e.email}</p>
                      </div>
                      {selected === e.id && <Check size={14} className="text-blue-400 flex-shrink-0" />}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wide">
                Reason (optional)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Why is this asset being transferred?"
                className="w-full bg-[#0f111a] border border-zinc-700/80 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-all resize-none"
              />
            </div>
          </div>

          <div className="px-5 py-4 border-t border-zinc-800 flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => selected && onConfirm(selected, reason || undefined)}
              disabled={submitting || !selected}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              {submitting ? "Submitting…" : "Request Transfer"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

// ── Types ─────────────────────────────────────────────────────
interface MyAsset {
  id: string;
  asset: {
    id: string;
    assetTag: string;
    name: string;
    condition: string;
    location?: string | null;
    category?: { name: string } | null;
  };
  expectedReturnDate?: string | null;
  status: string; // ACTIVE | RETURNED
  isOverdue?: boolean;
  daysOverdue?: number;
  createdAt: string;
}

interface Props {
  onNavigate: (page: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────
const daysUntil = (dateStr: string | null | undefined): number | null => {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
};

const conditionColor: Record<string, string> = {
  NEW: "text-emerald-400",
  GOOD: "text-blue-400",
  FAIR: "text-amber-400",
  POOR: "text-orange-400",
  DAMAGED: "text-red-400",
};
const conditionDot: Record<string, string> = {
  NEW: "bg-emerald-400",
  GOOD: "bg-blue-400",
  FAIR: "bg-amber-400",
  POOR: "bg-orange-400",
  DAMAGED: "bg-red-400",
};

// ── Toast ─────────────────────────────────────────────────────
const Toast = ({ toast }: { toast: { msg: string; type: string } | null }) => (
  <AnimatePresence>
    {toast && (
      <motion.div
        initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-xl text-sm font-medium
          shadow-2xl border flex items-center gap-2 whitespace-nowrap
          ${toast.type === "error"
            ? "bg-red-950 border-red-500/40 text-red-300"
            : "bg-emerald-950 border-emerald-500/40 text-emerald-300"}`}
      >
        {toast.type === "error" ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
        {toast.msg}
      </motion.div>
    )}
  </AnimatePresence>
);

// ── Main Component ────────────────────────────────────────────
export default function MyAssets({ onNavigate }: Props) {
  const [assets, setAssets] = useState<MyAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"All" | "Active" | "Overdue" | "Returned">("All");
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [actionLoad, setActionLoad] = useState<Record<string, string>>({});
  const [returnTarget, setReturnTarget] = useState<MyAsset | null>(null);
  const [returnCondition, setReturnCondition] = useState("GOOD");
  const [transferTarget, setTransferTarget] = useState<MyAsset | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [requestedTransferIds, setRequestedTransferIds] = useState<Record<string, boolean>>({});

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ── Fetch MY allocations — GET /allocations/my (employee-safe) ──
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // /allocations/my is JWT-scoped to this user — GET /allocations is
      // manager-only (403 for employees).
      const data = await apiGet<{ items: Array<Record<string, any>> }>("/allocations/my");
      const items: MyAsset[] = (data.items ?? []).map((a) => ({
        id: a.id,
        asset: {
          id: a.asset?.id ?? "",
          assetTag: a.asset?.assetTag ?? "",
          name: a.asset?.name ?? "Asset",
          condition: a.asset?.condition ?? "GOOD",
          location: a.asset?.location ?? null,
          category: a.asset?.category ?? null,
        },
        expectedReturnDate: a.expectedReturnDate ?? null,
        status: a.status ?? "ACTIVE",
        createdAt: a.createdAt ?? new Date().toISOString(),
      }));

      const enriched = items.map((a) => ({
        ...a,
        isOverdue:
          a.status === "ACTIVE" && !!a.expectedReturnDate
            ? new Date(a.expectedReturnDate) < new Date()
            : false,
        daysOverdue:
          a.status === "ACTIVE" && a.expectedReturnDate
            ? Math.max(0, Math.ceil((Date.now() - new Date(a.expectedReturnDate).getTime()) / 86400000))
            : 0,
      }));

      setAssets(enriched);
    } catch (e: any) {
      setError(e.message ?? "Could not load your assets. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Initiate Return — holder may return their own allocation ──
  const confirmReturn = async () => {
    if (!returnTarget) return;
    const allocationId = returnTarget.id;
    setActionLoad((p) => ({ ...p, [allocationId]: "return" }));
    try {
      await apiSend(`/allocations/${allocationId}/return`, "POST", {
        checkInNotes: "Returned from My Assets",
        conditionOnReturn: returnCondition,
      });
      setAssets((p) => p.map((a) => (a.id === allocationId ? { ...a, status: "RETURNED" } : a)));
      showToast(`${returnTarget.asset?.name ?? "Asset"} returned successfully`);
      setReturnTarget(null);
    } catch (e: any) {
      showToast(e?.message ?? "Return failed", "error");
    } finally {
      setActionLoad((p) => ({ ...p, [allocationId]: "" }));
    }
  };

  // ── Request Transfer — holder may request a transfer of their own asset ──
  const submitTransfer = async (toUserId: string, reason?: string) => {
    if (!transferTarget?.asset?.id) return;
    setTransferring(true);
    try {
      await apiSend("/transfers", "POST", {
        assetId: transferTarget.asset.id,
        toUserId,
        reason: reason || "Transfer requested from My Assets",
      });
      setRequestedTransferIds((p) => ({ ...p, [transferTarget.id]: true }));
      setTransferTarget(null);
      showToast("Transfer request submitted — pending approval");
    } catch (e: any) {
      showToast(e?.message ?? "Transfer request failed", "error");
    } finally {
      setTransferring(false);
    }
  };

  // ── Filter & search ───────────────────────────────────────
  const filtered = assets.filter((a) => {
    const matchFilter =
      filter === "All" ? true
      : filter === "Active" ? a.status === "ACTIVE" && !a.isOverdue
      : filter === "Overdue" ? !!a.isOverdue
      : a.status === "RETURNED";
    const q = search.toLowerCase();
    const matchSearch = !search ||
      a.asset?.name?.toLowerCase().includes(q) ||
      a.asset?.assetTag?.toLowerCase().includes(q) ||
      a.asset?.category?.name?.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  const overdueCount = assets.filter((a) => a.isOverdue).length;
  const activeCount = assets.filter((a) => a.status === "ACTIVE").length;
  const returnedCount = assets.filter((a) => a.status === "RETURNED").length;

  const FILTERS: Array<"All" | "Active" | "Overdue" | "Returned"> = ["All", "Active", "Overdue", "Returned"];

  return (
    <div className="w-full space-y-6">
      <Toast toast={toast} />

      {/* ── HEADER ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">My Assets</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Assets currently assigned to you — view details, initiate returns or transfers
          </p>
        </div>
        <button onClick={load}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#1a1d2e] text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* ── OVERDUE BANNER ── */}
      <AnimatePresence>
        {overdueCount > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="bg-red-950/50 border border-red-500/40 rounded-2xl px-5 py-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-bold text-red-400 mb-1">
                  {overdueCount} asset{overdueCount > 1 ? "s are" : " is"} overdue for return!
                </p>
                <p className="text-xs text-red-400/70">
                  Please return these items immediately to avoid escalation to your manager.
                </p>
              </div>
              <button onClick={() => setFilter("Overdue")}
                className="flex-shrink-0 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 px-3 py-1.5 rounded-lg transition-colors">
                View Overdue →
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── STATS STRIP ── */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Active", value: activeCount, color: "text-blue-400" },
          { label: "Overdue", value: overdueCount, color: "text-red-400" },
          { label: "Returned", value: returnedCount, color: "text-zinc-400" },
        ].map((s) => (
          <div key={s.label} className="bg-[#1a1d2e] border border-zinc-800 rounded-xl p-4 text-center">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* ── FILTER + SEARCH ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center bg-[#1a1d2e] border border-zinc-800 rounded-xl p-1 gap-0.5">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all
                ${filter === f ? "bg-blue-600 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-200"}`}>
              {f}
              {f === "Overdue" && overdueCount > 0 && (
                <span className="ml-1.5 text-[10px] bg-red-500/25 text-red-400 px-1.5 py-0.5 rounded-full">{overdueCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, tag, category…"
            className="bg-[#1a1d2e] border border-zinc-800 rounded-xl pl-9 pr-10 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/50 transition-colors w-64" />
          {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2"><X size={13} className="text-zinc-500 hover:text-white" /></button>}
        </div>
      </div>

      {/* ── ERROR ── */}
      {error && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-xl px-4 py-3 flex items-center gap-3 text-red-400 text-sm">
          <AlertCircle size={16} /> {error}
          <button onClick={load} className="ml-auto underline hover:text-red-300">Retry</button>
        </div>
      )}

      {/* ── LOADING ── */}
      {loading && (
        <div className="flex items-center justify-center py-20 gap-2 text-zinc-500">
          <Loader2 size={22} className="animate-spin text-blue-400" />
          <span>Loading your assets…</span>
        </div>
      )}

      {/* ── EMPTY ── */}
      {!loading && !error && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-zinc-500">
          <Package size={40} className="opacity-20" />
          <p className="text-sm font-medium">
            {filter !== "All" ? `No ${filter.toLowerCase()} assets` : "No assets assigned to you yet"}
          </p>
          <p className="text-xs text-zinc-600">Contact your Asset Manager to get equipment assigned</p>
        </div>
      )}

      {/* ── ASSET CARDS ── */}
      {!loading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((allocation, i) => {
            const asset = allocation.asset;
            const daysLeft = daysUntil(allocation.expectedReturnDate);
            const isOverdue = allocation.isOverdue;
            const isReturned = allocation.status === "RETURNED";
            const isDueSoon = !isOverdue && !isReturned && daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;
            const condKey = asset?.condition?.toUpperCase() ?? "GOOD";

            return (
              <motion.div key={allocation.id}
                initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className={`bg-[#1a1d2e] border rounded-2xl p-5 flex flex-col gap-4 transition-colors
                  ${isOverdue ? "border-red-500/40 shadow-[0_0_20px_rgba(239,68,68,0.1)]"
                  : isDueSoon ? "border-amber-500/30"
                  : isReturned ? "border-zinc-800/40 opacity-70"
                  : "border-zinc-800 hover:border-zinc-700"}`}
              >
                {/* Top row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-white leading-tight truncate">{asset?.name}</h3>
                    <p className="text-[11px] text-zinc-500 mt-0.5 font-mono">{asset?.assetTag}</p>
                  </div>

                  {/* Status badge */}
                  {isOverdue ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-1 rounded-full flex-shrink-0">
                      <AlertTriangle size={9} /> OVERDUE
                    </span>
                  ) : isDueSoon ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-1 rounded-full flex-shrink-0">
                      <Clock size={9} /> DUE SOON
                    </span>
                  ) : isReturned ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold bg-zinc-700/60 text-zinc-400 border border-zinc-600/40 px-2 py-1 rounded-full flex-shrink-0">
                      <CheckCircle2 size={9} /> RETURNED
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-1 rounded-full flex-shrink-0">
                      <Package size={9} /> ACTIVE
                    </span>
                  )}
                </div>

                {/* Details grid */}
                <div className="bg-[#0f111a] border border-zinc-800 rounded-xl p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-zinc-500"><Tag size={10} /> Category</span>
                    <span className="text-zinc-300 font-medium">{asset?.category?.name ?? "—"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-zinc-500"><BadgeCheck size={10} /> Condition</span>
                    <span className={`font-medium ${conditionColor[condKey] ?? "text-zinc-300"}`}>
                      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${conditionDot[condKey] ?? "bg-zinc-400"}`} />
                      {asset?.condition ?? "—"}
                    </span>
                  </div>
                  {asset?.location && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-zinc-500"><MapPin size={10} /> Location</span>
                      <span className="text-zinc-300 truncate max-w-[140px]">{asset.location}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-zinc-500"><Calendar size={10} /> Assigned</span>
                    <span className="text-zinc-300">{new Date(allocation.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-zinc-500"><Clock size={10} /> Return By</span>
                    {isReturned ? (
                      <span className="text-zinc-400">Returned</span>
                    ) : allocation.expectedReturnDate ? (
                      <span className={`font-medium ${isOverdue ? "text-red-400" : isDueSoon ? "text-amber-400" : "text-zinc-300"}`}>
                        {isOverdue
                          ? `Overdue by ${allocation.daysOverdue}d`
                          : daysLeft === 0
                            ? "Due today"
                            : `${new Date(allocation.expectedReturnDate).toLocaleDateString()} (${daysLeft}d)`}
                      </span>
                    ) : (
                      <span className="text-zinc-600">No fixed date</span>
                    )}
                  </div>
                </div>

                {/* Action buttons — only for ACTIVE assets */}
                {!isReturned && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setReturnTarget(allocation)}
                      disabled={!!actionLoad[allocation.id]}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl border border-zinc-700 bg-[#0f111a] hover:border-zinc-500 text-zinc-300 text-xs font-semibold transition-all disabled:opacity-50"
                    >
                      {actionLoad[allocation.id] === "return"
                        ? <Loader2 size={12} className="animate-spin" />
                        : <CornerUpLeft size={12} />}
                      Initiate Return
                    </button>
                    <button
                      onClick={() => setTransferTarget(allocation)}
                      disabled={!!requestedTransferIds[allocation.id]}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-xs font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ArrowLeftRight size={12} />
                      {requestedTransferIds[allocation.id] ? "Transfer Pending" : "Request Transfer"}
                    </button>
                  </div>
                )}

                {isReturned && (
                  <div className="py-2 px-3 rounded-xl bg-zinc-800/40 border border-zinc-700/50 text-center">
                    <span className="text-xs text-zinc-600">Asset returned — no actions available</span>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      {/* ── RETURN CONFIRM MODAL ── */}
      <AnimatePresence>
        {returnTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[150] flex items-center justify-center p-4"
            onClick={() => setReturnTarget(null)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 16 }}
              transition={{ type: "spring" as const, damping: 26, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[#1a1d2e] border border-zinc-700 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden"
            >
              <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-800">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                  <CornerUpLeft size={16} className="text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Initiate Return</h3>
                  <p className="text-[11px] text-zinc-500">
                    {returnTarget.asset?.name} &middot; {returnTarget.asset?.assetTag}
                  </p>
                </div>
              </div>
              <div className="p-5 space-y-4">
                <p className="text-sm text-zinc-300 leading-relaxed">
                  Return this asset now? It will be marked as returned and become available again.
                </p>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wide">
                    Condition on return
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {RETURN_CONDITIONS.map((c) => (
                      <button
                        key={c.value}
                        onClick={() => setReturnCondition(c.value)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                          returnCondition === c.value
                            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-400"
                            : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  {returnCondition === "POOR" || returnCondition === "DAMAGED" ? (
                    <p className="text-[11px] text-red-400 mt-2 flex items-center gap-1">
                      <AlertTriangle size={11} /> This will update the asset's recorded condition.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="px-5 py-4 border-t border-zinc-800 flex gap-3">
                <button
                  onClick={() => setReturnTarget(null)}
                  className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmReturn}
                  disabled={!!returnTarget && !!actionLoad[returnTarget.id]}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {!!returnTarget && actionLoad[returnTarget.id] === "return" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <CornerUpLeft size={14} />
                  )}
                  {!!returnTarget && actionLoad[returnTarget.id] === "return" ? "Returning…" : "Confirm Return"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── TRANSFER MODAL ── */}
      <TransferModal
        open={!!transferTarget}
        asset={transferTarget}
        submitting={transferring}
        currentUserId={getSession()?.user.id}
        onClose={() => setTransferTarget(null)}
        onConfirm={submitTransfer}
      />

      {/* ── INFO NOTICE ── */}
      <div className="flex items-start gap-2.5 bg-blue-950/30 border border-blue-500/20 rounded-xl px-4 py-3">
        <Info size={13} className="text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-blue-300/80 leading-relaxed">
          Only assets assigned directly to your account are shown here.
          To raise a maintenance request for a damaged asset, go to{" "}
          <button onClick={() => onNavigate("maintenance")} className="text-blue-300 underline hover:text-white">Maintenance</button>.
          For returns or transfers, use the buttons above or go to{" "}
          <button onClick={() => onNavigate("allocations")} className="text-blue-300 underline hover:text-white">Allocations & Transfers</button>.
        </p>
      </div>
    </div>
  );
}
