import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity as ActivityIcon,
  Search,
  Loader2,
  AlertCircle,
  Clock,
  User,
  X,
  FileJson,
  Fingerprint,
  Box,
  ChevronRight,
} from "lucide-react";
import { apiGet } from "@/lib/api";

interface LogEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  actor?: { name: string; email: string } | null;
  createdAt: string;
}

const actionColor = (action: string): string => {
  if (action.includes("allocat")) return "bg-info/20 text-info border-info/30";
  if (action.includes("maintenance")) return "bg-warning/20 text-warning border-warning/30";
  if (action.includes("transfer")) return "bg-violet/20 text-violet border-violet/30";
  if (action.includes("booking")) return "bg-cyan-500/20 text-cyan-400 border-cyan-500/30";
  if (action.includes("audit")) return "bg-success/20 text-success border-success/30";
  if (action.includes("user")) return "bg-danger/20 text-danger border-danger/30";
  return "bg-surface-3/40 text-ink-soft border-line-strong/40";
};

const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

// ─────────────────────────────────────────────────────────────
// DETAIL DRAWER — full record for one log entry
// ─────────────────────────────────────────────────────────────
const DetailDrawer = ({ item, onClose }: { item: LogEntry | null; onClose: () => void }) => {
  if (!item) return null;

  const pretty = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const metaEntries = item.metadata
    ? Object.entries(item.metadata)
    : [];

  return (
    <AnimatePresence>
      {item && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[90]"
            onClick={onClose}
          />
          {/* Drawer */}
          <motion.aside
            initial={{ x: 420, opacity: 0.5 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 420, opacity: 0 }}
            transition={{ type: "spring" as const, stiffness: 320, damping: 32 }}
            className="fixed top-0 right-0 h-full w-full max-w-md bg-surface-2 border-l border-line/70 shadow-2xl z-[100] flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-line flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-info/15 flex items-center justify-center">
                  <FileJson size={16} className="text-info" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-ink">Activity Detail</h2>
                  <p className="text-[11px] text-ink-subtle">Full audit record</p>
                </div>
              </div>
              <button aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
                <X size={16} className="text-ink-muted" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Action */}
              <div>
                <p className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest mb-1.5">Action</p>
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${actionColor(item.action)}`}>
                  {item.action}
                </span>
              </div>

              {/* Actor + timestamp */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-canvas border border-line rounded-xl px-4 py-3">
                  <p className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest mb-1 flex items-center gap-1">
                    <User size={10} /> Actor
                  </p>
                  <p className="text-sm font-semibold text-ink">{item.actor?.name ?? "System"}</p>
                  {item.actor?.email && (
                    <p className="text-[11px] text-ink-subtle truncate">{item.actor.email}</p>
                  )}
                </div>
                <div className="bg-canvas border border-line rounded-xl px-4 py-3">
                  <p className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest mb-1 flex items-center gap-1">
                    <Clock size={10} /> When
                  </p>
                  <p className="text-sm font-semibold text-ink">
                    {new Date(item.createdAt).toLocaleString()}
                  </p>
                  <p className="text-[11px] text-ink-subtle">{timeAgo(item.createdAt)}</p>
                </div>
              </div>

              {/* Entity */}
              <div>
                <p className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest mb-1.5 flex items-center gap-1">
                  <Box size={10} /> Entity
                </p>
                <div className="bg-canvas border border-line rounded-xl px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ink-subtle">Type</span>
                    <span className="text-ink font-medium">{item.entityType ?? "System"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ink-subtle">ID</span>
                    <span className="text-ink font-mono text-[11px]">{item.entityId ?? "—"}</span>
                  </div>
                </div>
              </div>

              {/* Metadata */}
              <div>
                <p className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest mb-1.5 flex items-center gap-1">
                  <Fingerprint size={10} /> Metadata
                </p>
                {metaEntries.length === 0 ? (
                  <div className="bg-canvas border border-line rounded-xl px-4 py-3 text-xs text-ink-faint">
                    No additional metadata recorded
                  </div>
                ) : (
                  <div className="bg-canvas border border-line rounded-xl overflow-hidden divide-y divide-line/60">
                    {metaEntries.map(([key, value]) => (
                      <div key={key} className="px-4 py-2.5">
                        <p className="text-[10px] font-bold text-info uppercase tracking-wide mb-0.5">{key}</p>
                        <pre className="text-[11px] text-ink-soft font-mono whitespace-pre-wrap break-all leading-relaxed">
                          {pretty(value)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
};

// ─────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────
export default function ActivityLogs() {
  const [items, setItems] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<LogEntry | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiGet<{ items: LogEntry[]; total: number }>("/activity");
        setItems(data.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const filtered = items.filter((item) => {
    const q = search.toLowerCase();
    return (
      !q ||
      item.action.toLowerCase().includes(q) ||
      (item.entityType ?? "").toLowerCase().includes(q) ||
      (item.actor?.name ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight">Activity Logs</h1>
          <p className="text-sm text-ink-muted mt-1">
            Immutable audit trail of every action across the system.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search actions, entities, actors…"
            className="w-full bg-surface-2 border border-line text-ink text-sm rounded-xl pl-9 pr-4 py-2.5 outline-none focus:border-info/50 placeholder:text-ink-faint"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="bg-danger/10 border border-danger/20 rounded-xl p-4 flex items-center gap-4 text-danger">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24 gap-2 text-ink-subtle">
          <Loader2 size={22} className="animate-spin text-info" />
          <span className="text-sm">Loading activity logs…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-ink-subtle">
          <ActivityIcon size={40} className="opacity-20 mb-3" />
          <p className="text-sm">No activity found.</p>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-surface-2 border border-line/80 rounded-2xl overflow-hidden"
        >
          <div className="divide-y divide-line/60">
            {filtered.map((item, i) => (
              <motion.button
                key={item.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.4) }}
                onClick={() => setSelected(item)}
                className="w-full px-5 py-3.5 flex items-center gap-4 hover:bg-surface-3/30 transition-colors text-left group"
              >
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border flex-shrink-0 ${actionColor(item.action)}`}>
                  {item.action}
                </span>
                <div className="flex-1 min-w-0 text-sm text-ink-soft">
                  <span className="text-ink-subtle">{item.entityType ?? "System"}</span>
                  {item.entityId && (
                    <span className="text-ink-faint font-mono text-xs"> #{item.entityId.slice(-6)}</span>
                  )}
                </div>
                <span className="flex items-center gap-1.5 text-xs text-ink-subtle flex-shrink-0">
                  <User size={11} /> {item.actor?.name ?? "System"}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-ink-faint flex-shrink-0">
                  <Clock size={11} /> {timeAgo(item.createdAt)}
                </span>
                <ChevronRight size={14} className="text-ink group-hover:text-info transition-colors flex-shrink-0" />
              </motion.button>
            ))}
          </div>
        </motion.div>
      )}

      {/* Detail drawer */}
      <DetailDrawer item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
