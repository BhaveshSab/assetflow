/**
 * The audit-cycle detail panel.
 *
 * It exists because three buttons on the audit cards used to do nothing at
 * all — "Continue Audit", "Close Cycle" and "View Discrepancy Report" were
 * <button> elements with no handler. This is what "Continue Audit" and "View
 * Discrepancy Report" open:
 *
 *   mode "items"          → every item of the cycle, each markable
 *                           VERIFIED / MISSING / DAMAGED (PATCH …/items/:id)
 *   mode "discrepancies"  → only the MISSING / DAMAGED ones, read-only
 *
 * The list is the server's, not a local copy: every mark is written through
 * the API and the list is re-read afterwards, so closing the panel and opening
 * it again shows what the database actually holds.
 */
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
} from "lucide-react";

import { apiGet, apiSend } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

export type AuditResult = "PENDING" | "VERIFIED" | "MISSING" | "DAMAGED";

export interface AuditItemRow {
  id: string;
  result: AuditResult;
  notes?: string | null;
  asset?: {
    id: string;
    name?: string | null;
    assetTag?: string | null;
    serialNumber?: string | null;
    location?: string | null;
  } | null;
  auditedBy?: { name?: string | null } | null;
}

export interface AuditCycleModalProps {
  cycleId: string;
  title: string;
  /** Which list to show. */
  mode: "items" | "discrepancies";
  /** Marks are only offered while the cycle is open. */
  readOnly?: boolean;
  onClose: () => void;
  /** Called after a mark was written, so the parent can refresh its counts. */
  onChanged?: () => void;
}

const RESULT_STYLES: Record<AuditResult, string> = {
  PENDING: "bg-ink-subtle/10 text-ink-muted border-line-strong/20",
  VERIFIED: "bg-success/10 text-success border-success/20",
  MISSING: "bg-danger/10 text-danger border-danger/20",
  DAMAGED: "bg-warning/10 text-warning border-warning/20",
};

const MARKS: AuditResult[] = ["VERIFIED", "MISSING", "DAMAGED"];

export default function AuditCycleModal({
  cycleId,
  title,
  mode,
  readOnly = false,
  onClose,
  onChanged,
}: AuditCycleModalProps) {
  const [items, setItems] = useState<AuditItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const path =
        mode === "discrepancies"
          ? `/audits/${cycleId}/discrepancies`
          : `/audits/${cycleId}/items`;
      const data = await apiGet<{ items: AuditItemRow[] }>(path);
      setItems(data.items ?? []);
    } catch (err) {
      setError(errorMessage(err, "Could not load this audit cycle."));
    } finally {
      setLoading(false);
    }
  }, [cycleId, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const mark = async (itemId: string, result: AuditResult) => {
    setBusyItem(itemId);
    setError(null);
    try {
      await apiSend(`/audits/${cycleId}/items/${itemId}`, "PATCH", { result });
      await load();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err, "Could not save that mark."));
    } finally {
      setBusyItem(null);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="audit-cycle-title"
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.97 }}
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id="audit-cycle-title" className="text-sm font-semibold text-ink">
                {mode === "discrepancies" ? "Discrepancy report" : "Audit items"}
              </h2>
              <p className="mt-0.5 text-xs text-ink-subtle">{title}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && (
              <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
                <Loader2 size={14} className="animate-spin" /> Loading…
              </p>
            )}

            {error && !loading && (
              <p role="alert" className="flex items-center gap-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                <AlertCircle size={14} /> {error}
              </p>
            )}

            {!loading && !error && items.length === 0 && (
              <p className="text-sm text-ink-muted">
                {mode === "discrepancies"
                  ? "Nothing is missing or damaged in this cycle."
                  : "This cycle has no items yet."}
              </p>
            )}

            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="rounded-xl border border-line bg-canvas px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">
                      {item.asset?.name ?? "Unknown asset"}
                    </span>
                    {item.asset?.assetTag && (
                      <span className="font-mono text-[11px] text-ink-subtle">
                        {item.asset.assetTag}
                      </span>
                    )}
                    <span
                      className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold ${RESULT_STYLES[item.result]}`}
                    >
                      {item.result}
                    </span>
                  </div>

                  {item.asset?.location && (
                    <p className="mt-1 text-[11px] text-ink-subtle">
                      {item.asset.location}
                    </p>
                  )}

                  {!readOnly && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {MARKS.map((result) => (
                        <button
                          key={result}
                          type="button"
                          disabled={busyItem === item.id || item.result === result}
                          onClick={() => void mark(item.id, result)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                            item.result === result
                              ? RESULT_STYLES[result]
                              : "border-line bg-surface text-ink-soft hover:bg-surface-3"
                          }`}
                        >
                          {result === "VERIFIED" && <CheckCircle2 size={11} />}
                          {result === "MISSING" && <AlertTriangle size={11} />}
                          {result === "DAMAGED" && <AlertTriangle size={11} />}
                          {busyItem === item.id ? "Saving…" : result}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="text-[11px] text-ink-subtle">
              {items.length} item{items.length === 1 ? "" : "s"}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line bg-canvas px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:bg-surface-3"
            >
              Done
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
