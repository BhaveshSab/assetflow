import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bell, X, CheckCheck, AlertTriangle, Wrench, CalendarCheck,
  ArrowLeftRight, ClipboardList, Info, Package, CornerUpLeft,
  type LucideIcon,
} from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";

// ─────────────────────────────────────────────────────────────
// TYPES — matches the real backend Notification model:
//   { id, type, message, isRead, relatedEntityType?,
//     relatedEntityId?, createdAt }
// ─────────────────────────────────────────────────────────────
interface Notification {
  id: string;
  type: string;
  message: string;
  isRead: boolean;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  createdAt: string;
}

const timeAgo = (dateStr: string) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/** Friendly title + icon per backend NotificationType enum. */
const typeConfig: Record<string, { title: string; border: string; dot: string; icon: LucideIcon }> = {
  OVERDUE_RETURN:       { title: "Overdue Return",       border: "border-l-red-500",     dot: "bg-danger",     icon: AlertTriangle },
  ASSET_ASSIGNED:       { title: "Asset Assigned",       border: "border-l-emerald-500", dot: "bg-success", icon: Package },
  ASSET_RETURNED:       { title: "Asset Returned",       border: "border-l-emerald-500", dot: "bg-success", icon: CornerUpLeft },
  TRANSFER_REQUESTED:   { title: "Transfer Requested",   border: "border-l-blue-500",    dot: "bg-info",    icon: ArrowLeftRight },
  TRANSFER_APPROVED:    { title: "Transfer Approved",    border: "border-l-blue-500",    dot: "bg-info",    icon: ArrowLeftRight },
  TRANSFER_REJECTED:    { title: "Transfer Rejected",    border: "border-l-red-500",     dot: "bg-danger",     icon: ArrowLeftRight },
  MAINTENANCE_RAISED:   { title: "Maintenance Raised",   border: "border-l-amber-500",   dot: "bg-warning",   icon: Wrench },
  MAINTENANCE_APPROVED: { title: "Maintenance Approved", border: "border-l-amber-500",   dot: "bg-warning",   icon: Wrench },
  MAINTENANCE_REJECTED: { title: "Maintenance Rejected", border: "border-l-red-500",     dot: "bg-danger",     icon: Wrench },
  MAINTENANCE_RESOLVED: { title: "Maintenance Resolved", border: "border-l-emerald-500", dot: "bg-success", icon: Wrench },
  BOOKING_CONFIRMED:    { title: "Booking Confirmed",    border: "border-l-purple-500",  dot: "bg-violet",  icon: CalendarCheck },
  BOOKING_CANCELLED:    { title: "Booking Cancelled",    border: "border-l-red-500",     dot: "bg-danger",     icon: CalendarCheck },
  BOOKING_REMINDER:     { title: "Booking Reminder",     border: "border-l-purple-500",  dot: "bg-violet",  icon: CalendarCheck },
  AUDIT_ASSIGNED:       { title: "Audit Assigned",       border: "border-l-cyan-500",    dot: "bg-cyan-400",    icon: ClipboardList },
  AUDIT_DISCREPANCY:    { title: "Audit Discrepancy",    border: "border-l-cyan-500",    dot: "bg-cyan-400",    icon: ClipboardList },
  AUDIT_CLOSED:         { title: "Audit Closed",         border: "border-l-cyan-500",    dot: "bg-cyan-400",    icon: ClipboardList },
};
const defaultCfg = { title: "Notification", border: "border-l-zinc-600", dot: "bg-ink-subtle", icon: Info };

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // ── Fetch from real backend ──────────────────────────────────
  const fetchNotifs = useCallback(async () => {
    try {
      const data = await apiGet<{ items: Notification[]; unreadCount?: number }>("/notifications");
      const items = Array.isArray(data) ? data : (data.items ?? []);
      setNotifs(items);
      setUnreadCount(
        typeof data.unreadCount === "number"
          ? data.unreadCount
          : items.filter((n) => !n.isRead).length,
      );
      setError("");
    } catch {
      setError("Could not load notifications");
    }
  }, []);

  // Poll every 30s — no overlapping requests, nothing while the tab is hidden.
  usePolling(fetchNotifs, 30_000);

  // ── Close on outside click ───────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Mark single read ─────────────────────────────────────────
  const markRead = async (n: Notification) => {
    if (n.isRead) return;
    try {
      await apiSend(`/notifications/${n.id}/read`, "PATCH");
      setNotifs((p) => p.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // non-critical — leave as-is
    }
  };

  // ── Mark all read ────────────────────────────────────────────
  const markAllRead = async () => {
    setLoading(true);
    try {
      await apiSend("/notifications/read-all", "POST");
      setNotifs((p) => p.map((x) => ({ ...x, isRead: true })));
      setUnreadCount(0);
    } catch {
      setError("Failed to mark all as read");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      {/* ── Bell button ── */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex items-center justify-center rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-3/60 hover:text-ink"
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-danger text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </motion.span>
        )}
      </button>

      {/* ── Dropdown panel ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-12 w-[min(20rem,calc(100vw-2rem))] bg-surface border border-line rounded-2xl shadow-2xl z-50 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <div className="flex items-center gap-2">
                <Bell size={14} className="text-ink-muted" />
                <span className="text-sm font-semibold text-ink">Notifications</span>
                {unreadCount > 0 && (
                  <span className="text-[10px] bg-danger/20 text-danger border border-danger/30 px-1.5 py-0.5 rounded-full font-bold">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    disabled={loading}
                    title="Mark all read"
                    className="flex items-center gap-1 text-[11px] text-info hover:text-info transition-colors disabled:opacity-50"
                  >
                    <CheckCheck size={13} />
                    All read
                  </button>
                )}
                <button onClick={() => setOpen(false)}>
                  <X size={14} className="text-ink-subtle hover:text-ink transition-colors" />
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div role="alert" className="px-4 py-2 text-xs text-danger bg-danger/8 border-b border-danger/20">
                {error}
              </div>
            )}

            {/* List */}
            <div className="max-h-80 overflow-y-auto divide-y divide-line/50">
              {notifs.length === 0 ? (
                <div className="py-10 flex flex-col items-center gap-2 text-ink-faint">
                  <Bell size={28} className="opacity-30" />
                  <p className="text-sm">No notifications</p>
                </div>
              ) : (
                notifs.map((n) => {
                  const cfg = typeConfig[n.type] ?? defaultCfg;
                  const Icon = cfg.icon;
                  return (
                    <button
                      key={n.id}
                      onClick={() => markRead(n)}
                      className={`w-full text-left px-4 py-3 border-l-2 ${cfg.border}
                        ${n.isRead ? "opacity-60" : "bg-surface-3/20"}
                        hover:bg-surface-3/30 transition-colors`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${n.isRead ? "bg-surface-3" : "bg-surface-3"}`}>
                          <Icon size={12} className={n.isRead ? "text-ink-subtle" : "text-ink"} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-semibold leading-snug ${n.isRead ? "text-ink-muted" : "text-ink"}`}>
                            {cfg.title}
                          </p>
                          <p className="text-[11px] text-ink-subtle mt-0.5 leading-relaxed line-clamp-2">
                            {n.message}
                          </p>
                          <p className="text-[10px] text-ink-faint mt-1">{timeAgo(n.createdAt)}</p>
                        </div>
                        {!n.isRead && (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${cfg.dot}`} />
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer */}
            {notifs.length > 0 && (
              <div className="px-4 py-2.5 border-t border-line text-center">
                <span className="text-[11px] text-ink-faint">
                  {notifs.length} total · {unreadCount} unread
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
