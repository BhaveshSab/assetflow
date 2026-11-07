import { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Search, AlertTriangle, Clock, CheckCircle2,
  Activity, Wrench, X, ChevronDown, User, Calendar,
  FileText, Loader2, Check, MoreVertical,
  Package, UserCheck, AlertCircle, Download,
  ClipboardList, Camera,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
type Status   = "Pending" | "Approved" | "In Progress" | "Resolved" | "Rejected";
type Priority = "HIGH" | "MEDIUM" | "LOW";

interface MaintenanceRequest {
  id:          string;
  reqId:       string;
  assetName:   string;
  assetTag:    string;
  issue:       string;
  priority:    Priority;
  status:      Status;
  requestedBy: string;
  raisedOn:    string;
  technician?: string;
  photo?:      string;
}

interface RaiseRequestPayload {
  assetId:     string;
  assetTag:    string;
  assetName:   string;
  issue:       string;
  priority:    Priority;
  requestedBy: string;
  photo?:      string;
}

interface AssetOption {
  id: string;
  assetTag: string;
  name: string;
}

export interface MaintenanceProps {
  userRole?: "ADMIN" | "ASSET_MANAGER" | "EMPLOYEE";
  currentUser?: string;
  currentUserId?: string;
}

// ─────────────────────────────────────────────────────────────
// SERVICE LAYER (real backend)
// ─────────────────────────────────────────────────────────────
import { apiGet, apiSend } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/utils";

// Backend statuses are SNAKE_CASE → the component's display statuses.
const BACKEND_STATUS: Record<string, Status> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  TECHNICIAN_ASSIGNED: "In Progress",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
};

interface RawMaintenanceRequest {
  id: string;
  asset?: { name?: string; assetTag?: string } | null;
  description?: string;
  priority?: string;
  status?: string;
  raisedBy?: { name?: string } | null;
  technician?: { name?: string } | null;
  technicianName?: string;
  photoUrl?: string;
  createdAt?: string;
}

const toRequest = (r: RawMaintenanceRequest): MaintenanceRequest => ({
  id: r.id,
  reqId: `REQ-${String(r.id ?? "").slice(-6).toUpperCase()}`,
  assetName: r.asset?.name ?? "Asset",
  assetTag: r.asset?.assetTag ?? "",
  issue: r.description ?? "",
  priority: (r.priority ?? "MEDIUM") as Priority,
  status: BACKEND_STATUS[r.status ?? "PENDING"] ?? "Pending",
  requestedBy: r.raisedBy?.name ?? "—",
  raisedOn: r.createdAt ? r.createdAt.slice(0, 10) : "",
  technician: r.technicianName ?? undefined,
  photo: r.photoUrl ?? undefined,
});

/** What an action on a request reports back to the screen. */
type ActionResult = { success: true } | { success: false; error: string };

const maintenanceService = {
  getAll: async (mine = false): Promise<MaintenanceRequest[]> => {
    const path = mine ? "/maintenance?mine=true" : "/maintenance";
    const data = await apiGet<{ items: RawMaintenanceRequest[] }>(path);
    return (data.items ?? []).map(toRequest);
  },

  raiseRequest: async (payload: RaiseRequestPayload) => {
    const created = await apiSend<RawMaintenanceRequest>("/maintenance", "POST", {
      assetId: payload.assetId,
      description: payload.issue,
      priority: payload.priority,
      photoUrl: payload.photo ?? undefined,
    });
    return toRequest(created);
  },

  // Each of these used to `catch { return false; }`, and the callers ignored
  // the result — so a refused approval, assignment or resolution still showed a
  // success toast and flipped the card locally. Return the reason instead.
  approve: async (id: string): Promise<ActionResult> => {
    try {
      await apiSend(`/maintenance/${id}/approve`, "POST", {});
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err, "Approval failed") };
    }
  },

  reject: async (id: string): Promise<ActionResult> => {
    try {
      await apiSend(`/maintenance/${id}/reject`, "POST", {});
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err, "Rejection failed") };
    }
  },

  assignTechnician: async (
    id: string,
    technicianName: string,
  ): Promise<ActionResult> => {
    try {
      await apiSend(`/maintenance/${id}/assign`, "POST", { technicianName });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: errorMessage(err, "Could not assign the technician"),
      };
    }
  },

  resolve: async (id: string, notes: string): Promise<ActionResult> => {
    try {
      await apiSend(`/maintenance/${id}/resolve`, "POST", {
        resolutionNotes: notes || undefined,
      });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: errorMessage(err, "Could not mark the request resolved"),
      };
    }
  },

  getAssets: async (): Promise<AssetOption[]> => {
    const data = await apiGet<{ items: Array<{ id: string; assetTag: string; name: string }> }>("/assets");
    return (data.items ?? []).map((a) => ({
      id: a.id,
      assetTag: a.assetTag,
      name: a.name,
    }));
  },

  getTechnicians: async (): Promise<Array<{ id: string; name: string; email: string }>> => {
    const data = await apiGet<{ items: Array<{ id: string; name: string; email: string }> }>(
      "/org/employees?status=ACTIVE",
    );
    return data.items ?? [];
  },

  exportPdf: (requests: MaintenanceRequest[]) => {
    const rows = requests.map((r) =>
      `<tr style="border-bottom:1px solid #333">
        <td style="padding:8px">${r.reqId}</td>
        <td style="padding:8px">${r.assetName}</td>
        <td style="padding:8px">${r.assetTag}</td>
        <td style="padding:8px">${r.priority}</td>
        <td style="padding:8px">${r.status}</td>
        <td style="padding:8px">${r.requestedBy}</td>
        <td style="padding:8px">${r.raisedOn}</td>
      </tr>`
    ).join("");

    const html = `
      <html><head><title>Maintenance Report</title>
      <style>body{font-family:Arial;color:#fff;background:#0f111a;padding:24px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{background:#1a1d2e;padding:10px 8px;text-align:left;color:#60a5fa}
      td{color:#d1d5db}</style></head>
      <body>
        <h2 style="color:#fff;margin-bottom:4px">AssetFlow — Maintenance Report</h2>
        <p style="color:#6b7280;margin-bottom:20px">Generated: ${new Date().toLocaleString()}</p>
        <table>
          <thead><tr>
            <th>Req ID</th><th>Asset</th><th>Tag</th>
            <th>Priority</th><th>Status</th><th>Requested By</th><th>Date</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </body></html>`;

    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); w.print(); }
  },
};

// ─────────────────────────────────────────────────────────────
// STATUS & PRIORITY CONFIG
// ─────────────────────────────────────────────────────────────
const statusConfig: Record<Status, { color: string; icon: React.ElementType }> = {
  Pending:       { color: "bg-warning/20 text-warning border-warning/30",         icon: Clock        },
  Approved:      { color: "bg-info/20 text-info border-info/30",            icon: CheckCircle2 },
  "In Progress": { color: "bg-violet/20 text-violet border-violet/30",      icon: Activity     },
  Resolved:      { color: "bg-success/20 text-success border-success/30",   icon: CheckCircle2 },
  Rejected:      { color: "bg-danger/20 text-danger border-danger/30",               icon: X            },
};

const priorityConfig: Record<Priority, { color: string; bg: string }> = {
  HIGH:   { color: "text-danger",     bg: "bg-danger/15 border border-danger/30"     },
  MEDIUM: { color: "text-warning",   bg: "bg-warning/15 border border-warning/30" },
  LOW:    { color: "text-success", bg: "bg-success/15 border border-success/30" },
};

// ─────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────
const Toast = ({ toast }: { toast: { msg: string; type: string } | null }) => (
  <AnimatePresence>
    {toast && (
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-xl text-sm font-medium shadow-2xl border flex items-center gap-2 whitespace-nowrap
          ${toast.type === "error"   ? "bg-danger/25 border-danger/40 text-danger"
          : toast.type === "warning" ? "bg-warning/25 border-warning/40 text-warning"
          :                            "bg-success/25 border-success/40 text-success"}`}
      >
        {toast.type === "error" ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
        {toast.msg}
      </motion.div>
    )}
  </AnimatePresence>
);

// ─────────────────────────────────────────────────────────────
// BADGES
// ─────────────────────────────────────────────────────────────
const StatusBadge = ({ status }: { status: Status }) => {
  const cfg  = statusConfig[status];
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${cfg.color}`}>
      <Icon size={11} /> {status}
    </span>
  );
};

const PriorityBadge = ({ priority }: { priority: Priority }) => {
  const cfg = priorityConfig[priority];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${cfg.bg} ${cfg.color}`}>
      <AlertTriangle size={9} /> {priority}
    </span>
  );
};

// ─────────────────────────────────────────────────────────────
// RAISE REQUEST MODAL
// ─────────────────────────────────────────────────────────────
const RaiseRequestModal = ({
  open, onClose, onSuccess, currentUser = "Current User",
}: { open: boolean; onClose: () => void; onSuccess: (req: MaintenanceRequest) => void; currentUser?: string }) => {

  const [assets,      setAssets]      = useState<AssetOption[]>([]);
  const [fetching,    setFetching]    = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetOpen,   setAssetOpen]   = useState(false);
  const [errors,      setErrors]      = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    asset:    null as AssetOption | null,
    issue:    "",
    priority: "MEDIUM" as Priority,
    photo:    "",
  });

  useEffect(() => {
    if (!open) return;
    setFetching(true);
    void maintenanceService.getAssets().then(setAssets).finally(() => setFetching(false));
    setForm({ asset: null, issue: "", priority: "MEDIUM", photo: "" });
    setErrors({});
    setSubmitError("");
    setAssetSearch("");
  }, [open]);

  const filteredAssets = useMemo(() =>
    assetSearch ? assets.filter(a =>
      a.name.toLowerCase().includes(assetSearch.toLowerCase()) ||
      a.assetTag.toLowerCase().includes(assetSearch.toLowerCase())
    ) : assets, [assets, assetSearch]);

  const set = (field: string, value: unknown) => {
    setForm(p => ({ ...p, [field]: value }));
    setErrors(p => ({ ...p, [field]: "" }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.asset) e.asset = "Please select an asset";
    if (!form.issue.trim()) e.issue = "Describe the issue";
    else if (form.issue.trim().length < 10) e.issue = "Please provide more detail (min 10 chars)";
    return e;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload: RaiseRequestPayload = {
        assetId:     form.asset!.id,
        assetTag:    form.asset!.assetTag,
        assetName:   form.asset!.name,
        issue:       form.issue.trim(),
        priority:    form.priority,
        requestedBy: currentUser,
        photo:       form.photo || undefined,
      };
      const result = await maintenanceService.raiseRequest(payload);
      onSuccess(result as MaintenanceRequest);
    } catch (err) {
      setSubmitError(errorMessage(err, "Failed to raise request. Please try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = (field: string) =>
    `w-full bg-canvas border rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none transition-all
    ${errors[field] ? "border-danger/60" : "border-line focus:border-info/60"}`;

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.93, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.93, opacity: 0, y: 20 }}
            transition={{ type: "spring" as const, damping: 26, stiffness: 300 }}
            onClick={e => e.stopPropagation()}
            className="bg-surface border border-line/80 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[95vh] flex flex-col"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-line flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-warning/15 flex items-center justify-center">
                  <Wrench size={17} className="text-warning" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-ink">Raise Maintenance Request</h2>
                  <p className="text-[11px] text-ink-subtle">Report a broken or faulty asset for repair</p>
                </div>
              </div>
              <button aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
                <X size={16} className="text-ink-muted" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
              {/* Global submit error */}
              {submitError && (
                <div className="flex items-center gap-2.5 bg-danger/10 border border-danger/30 rounded-xl px-4 py-2.5 text-sm text-danger">
                  <AlertCircle size={14} className="flex-shrink-0" /> {submitError}
                </div>
              )}

              {/* Asset Selector */}
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">
                  Asset <span className="text-danger">*</span>
                </label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAssetOpen(o => !o)}
                    className={`w-full flex items-center gap-2 px-3.5 py-2.5 rounded-xl border text-left transition-all text-sm
                      ${errors.asset ? "border-danger/60" : assetOpen ? "border-info/60" : "border-line hover:border-line-strong"}
                      bg-canvas`}
                  >
                    <Package size={14} className="text-ink-subtle flex-shrink-0" />
                    <span className={form.asset ? "text-ink flex-1" : "text-ink-faint flex-1"}>
                      {form.asset ? `${form.asset.name} (${form.asset.assetTag})` : "Search and select asset…"}
                    </span>
                    <ChevronDown size={13} className={`text-ink-subtle transition-transform ${assetOpen ? "rotate-180" : ""}`} />
                  </button>

                  <AnimatePresence>
                    {assetOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                        className="absolute z-50 top-full mt-1.5 w-full bg-surface border border-line rounded-xl shadow-2xl overflow-hidden"
                      >
                        <div className="p-2 border-b border-line">
                          <div className="relative">
                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                            <input autoFocus value={assetSearch} onChange={e => setAssetSearch(e.target.value)}
                              placeholder="Search assets…"
                              className="w-full bg-canvas border border-line rounded-lg pl-7 pr-3 py-1.5 text-xs text-ink outline-none focus:border-info/50" />
                          </div>
                        </div>
                        <div className="max-h-44 overflow-y-auto">
                          {fetching ? (
                            <div className="py-4 text-center text-xs text-ink-subtle flex items-center justify-center gap-1.5">
                              <Loader2 size={13} className="animate-spin" /> Loading…
                            </div>
                          ) : filteredAssets.length === 0 ? (
                            <div className="py-4 text-center text-xs text-ink-subtle">No assets found</div>
                          ) : filteredAssets.map(a => (
                            <button key={a.id} type="button"
                              onClick={() => { set("asset", a); setAssetOpen(false); setAssetSearch(""); }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-surface-3/40 transition-colors text-left"
                            >
                              <Package size={13} className="text-info flex-shrink-0" />
                              <div>
                                <p className="text-sm text-ink">{a.name}</p>
                                <p className="text-[11px] text-ink-subtle">{a.assetTag}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                {errors.asset && <p className="text-danger text-[11px] mt-1 flex items-center gap-1"><AlertTriangle size={10} />{errors.asset}</p>}
              </div>

              {/* Issue Description */}
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">
                  Issue Description <span className="text-danger">*</span>
                </label>
                <div className="relative">
                  <FileText size={14} className="absolute left-3.5 top-3 text-ink-subtle" />
                  <textarea
                    value={form.issue}
                    onChange={e => set("issue", e.target.value)}
                    placeholder="Describe the problem in detail…"
                    rows={3}
                    className={`${inputCls("issue")} pl-9 resize-none`}
                  />
                </div>
                <div className="flex items-center justify-between mt-1">
                  {errors.issue
                    ? <p className="text-danger text-[11px] flex items-center gap-1"><AlertTriangle size={10} />{errors.issue}</p>
                    : <span />}
                  <span className="text-[11px] text-ink-faint ml-auto">{form.issue.length}/500</span>
                </div>
              </div>

              {/* Priority */}
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-2">Priority</label>
                <div className="flex gap-2">
                  {(["HIGH", "MEDIUM", "LOW"] as Priority[]).map(p => {
                    const cfg = priorityConfig[p];
                    return (
                      <button key={p} type="button" onClick={() => set("priority", p)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl border text-xs font-bold transition-all
                          ${form.priority === p ? `${cfg.bg} ${cfg.color}` : "border-line text-ink-subtle hover:border-line-strong"}`}
                      >
                        <AlertTriangle size={11} /> {p}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Photo upload */}
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Attach Photo (optional)</label>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-dashed border-line hover:border-line-strong transition-colors text-sm text-ink-subtle hover:text-ink-soft"
                >
                  <Camera size={16} />
                  {form.photo ? "Photo attached ✓" : "Click to attach a photo of the issue"}
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { if (e.target.files?.[0]) set("photo", e.target.files[0].name); }} />
              </div>

              {form.priority === "HIGH" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                  className="flex items-center gap-2.5 bg-danger/8 border border-danger/25 rounded-xl px-4 py-2.5"
                >
                  <AlertCircle size={14} className="text-danger flex-shrink-0" />
                  <p className="text-[11px] text-danger">
                    HIGH priority requests must be approved by an Asset Manager before work begins.
                    Asset will be marked <span className="font-bold">Under Maintenance</span> on approval.
                  </p>
                </motion.div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-line flex gap-3 flex-shrink-0">
              <button aria-label="Close" onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all">
                Cancel
              </button>
              <button onClick={handleSubmit} disabled={submitting}
                className="flex-1 py-2.5 rounded-xl bg-warning hover:bg-warning text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                {submitting
                  ? <><Loader2 size={14} className="animate-spin" /> Submitting…</>
                  : <><Wrench size={14} /> Raise Request</>}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ─────────────────────────────────────────────────────────────
// ASSIGN TECHNICIAN MODAL
// ─────────────────────────────────────────────────────────────
const AssignTechnicianModal = ({
  open, request, onClose, onSuccess,
}: { open: boolean; request: MaintenanceRequest | null; onClose: () => void; onSuccess: (name: string) => void }) => {
  const [employees,  setEmployees]  = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [loadingEmps, setLoadingEmps] = useState(false);
  const [selected,   setSelected]   = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState("");

  useEffect(() => {
    if (!open) return;
    setSelected("");
    setError("");
    setLoadingEmps(true);
    maintenanceService
      .getTechnicians()
      .then(setEmployees)
      .catch(() => setEmployees([]))
      .finally(() => setLoadingEmps(false));
  }, [open]);

  const handleAssign = async () => {
    if (!selected || !request) return;
    setSubmitting(true);
    setError("");
    const res = await maintenanceService.assignTechnician(request.id, selected);
    setSubmitting(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    onSuccess(selected);
  };

  const initials = (name: string) =>
    name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2) || "—";

  return (
    <AnimatePresence>
      {open && request && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[110] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.93, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.93, opacity: 0 }}
            transition={{ type: "spring" as const, damping: 26, stiffness: 300 }}
            onClick={e => e.stopPropagation()}
            className="bg-surface border border-line rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-info/15 flex items-center justify-center">
                  <UserCheck size={15} className="text-info" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-ink">Assign Technician</h3>
                  <p className="text-[11px] text-ink-subtle">{request.assetName}</p>
                </div>
              </div>
              <button aria-label="Close" onClick={onClose}><X size={15} className="text-ink-muted hover:text-ink" /></button>
            </div>

            <div className="p-5">
              <p className="text-xs text-ink-subtle mb-3">
                Choose who will work on this request — the name is recorded on the request.
              </p>
              <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                {loadingEmps ? (
                  <div className="py-6 flex items-center justify-center gap-2 text-ink-subtle text-sm">
                    <Loader2 size={14} className="animate-spin text-info" />
                    Loading employees…
                  </div>
                ) : employees.length === 0 ? (
                  <div className="py-6 text-center text-xs text-ink-faint">
                    No active employees found. Create one in Organization Setup first.
                  </div>
                ) : employees.map(e => (
                  <button key={e.id} onClick={() => setSelected(e.name)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left
                      ${selected === e.name
                        ? "border-info/50 bg-info/10 text-ink"
                        : "border-line text-ink-muted hover:border-line-strong hover:text-ink"}`}
                  >
                    <div className="w-8 h-8 rounded-full bg-info flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                      {initials(e.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{e.name}</p>
                      <p className="text-[11px] text-ink-subtle truncate">{e.email}</p>
                    </div>
                    {selected === e.name && <Check size={14} className="text-info" />}
                  </button>
                ))}
              </div>
              {error && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-danger">
                  <AlertCircle size={12} /> {error}
                </p>
              )}
            </div>

            <div className="px-5 py-4 border-t border-line flex gap-3">
              <button aria-label="Close" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong transition-all">
                Cancel
              </button>
              <button onClick={handleAssign} disabled={!selected || submitting}
                className="flex-1 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                {submitting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {submitting ? "Assigning…" : "Assign"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ─────────────────────────────────────────────────────────────
// RESOLVE MODAL
// ─────────────────────────────────────────────────────────────
const ResolveModal = ({
  open, request, onClose, onSuccess,
}: { open: boolean; request: MaintenanceRequest | null; onClose: () => void; onSuccess: () => void }) => {
  const [notes,      setNotes]      = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState("");

  const handleResolve = async () => {
    if (!request) return;
    setSubmitting(true);
    setError("");
    const res = await maintenanceService.resolve(request.id, notes);
    setSubmitting(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    onSuccess();
  };

  return (
    <AnimatePresence>
      {open && request && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[110] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.93, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.93, opacity: 0 }}
            transition={{ type: "spring" as const, damping: 26, stiffness: 300 }}
            onClick={e => e.stopPropagation()}
            className="bg-surface border border-line rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-success/15 flex items-center justify-center">
                  <CheckCircle2 size={15} className="text-success" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-ink">Mark as Resolved</h3>
                  <p className="text-[11px] text-ink-subtle">{request.assetName}</p>
                </div>
              </div>
              <button aria-label="Close" onClick={onClose}><X size={15} className="text-ink-muted hover:text-ink" /></button>
            </div>

            <div className="p-5">
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Resolution Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="What was done to fix the issue?"
                rows={3}
                className="w-full bg-canvas border border-line rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-success/50 transition-colors resize-none" />
              <p className="text-[11px] text-ink-faint mt-2">
                The asset status will automatically revert to <span className="text-ink font-medium">Available</span> after resolution.
              </p>
              {error && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-danger">
                  <AlertCircle size={12} /> {error}
                </p>
              )}
            </div>

            <div className="px-5 py-4 border-t border-line flex gap-3">
              <button aria-label="Close" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong transition-all">
                Cancel
              </button>
              <button onClick={handleResolve} disabled={submitting}
                className="flex-1 py-2.5 rounded-xl bg-success hover:bg-success text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                {submitting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                {submitting ? "Resolving…" : "Mark Resolved"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ─────────────────────────────────────────────────────────────
// THREE-DOT ACTION MENU
// ─────────────────────────────────────────────────────────────
const ActionMenu = ({
  onExport, onClose,
}: { onExport: () => void; onClose: () => void }) => (
  <motion.div
    initial={{ opacity: 0, scale: 0.9, y: -8 }}
    animate={{ opacity: 1, scale: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.9, y: -8 }}
    className="absolute right-0 top-8 z-50 w-44 bg-surface border border-line rounded-xl shadow-2xl overflow-hidden"
    onClick={e => e.stopPropagation()}
  >
    {[
      { label: "View Details",   icon: ClipboardList, action: () => {} },
      { label: "Export PDF",     icon: Download,      action: onExport  },
    ].map(({ label, icon: Icon, action }) => (
      <button key={label} onClick={() => { action(); onClose(); }}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-ink-muted hover:bg-surface-3/50 hover:text-ink transition-colors">
        <Icon size={13} /> {label}
      </button>
    ))}
  </motion.div>
);

// ─────────────────────────────────────────────────────────────
// MAINTENANCE CARD
// ─────────────────────────────────────────────────────────────
const MaintenanceCard = ({
  request, onApprove, onReject, onAssign, onResolve, userRole, delay, onExportSingle,
}: {
  request: MaintenanceRequest;
  onApprove: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
  onAssign: () => void;
  onResolve: () => void;
  userRole: "ADMIN" | "ASSET_MANAGER" | "EMPLOYEE";
  delay: number;
  onExportSingle: () => void;
}) => {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [menuOpen,      setMenuOpen]      = useState(false);

  // Loading state is tied to the real API call, not a simulated delay.
  const handleApprove = async () => {
    setActionLoading("approve");
    try {
      await onApprove();
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    setActionLoading("reject");
    try {
      await onReject();
    } finally {
      setActionLoading(null);
    }
  };

  const isManager = userRole === "ADMIN" || userRole === "ASSET_MANAGER";

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ delay, duration: 0.3 }}
      className="bg-surface border border-line/80 rounded-2xl p-5 flex flex-col gap-4 hover:border-line transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-ink leading-tight">{request.assetName}</h3>
          <p className="text-[11px] text-ink-subtle mt-0.5">{request.assetTag} • {request.reqId}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusBadge status={request.status} />
          <div className="relative">
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
              className="p-1.5 rounded-lg text-ink-faint hover:text-ink-soft hover:bg-surface-3/50 transition-colors"
            >
              <MoreVertical size={14} />
            </button>
            <AnimatePresence>
              {menuOpen && (
                <ActionMenu
                  onExport={onExportSingle}
                  onClose={() => setMenuOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="bg-canvas border border-line rounded-xl p-3.5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest">Issue Description</span>
          <PriorityBadge priority={request.priority} />
        </div>
        <p className="text-xs text-ink-soft leading-relaxed">{request.issue}</p>
      </div>

      <div className="flex items-center justify-between text-[11px] text-ink-subtle">
        <span className="flex items-center gap-1.5"><User size={11} /> {request.requestedBy}</span>
        <span className="flex items-center gap-1.5"><Calendar size={11} /> {request.raisedOn}</span>
      </div>

      {request.technician && (
        <div className="flex items-center gap-1.5 text-[11px] text-info bg-info/10 border border-info/20 rounded-lg px-3 py-1.5">
          <UserCheck size={11} /> Technician: {request.technician}
        </div>
      )}

      <div className="flex gap-2">
        {request.status === "Pending" && isManager && (
          <>
            <button onClick={handleApprove} disabled={!!actionLoading}
              className="flex-1 py-2 rounded-xl bg-info hover:bg-info text-white text-xs font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-60">
              {actionLoading === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Approve
            </button>
            <button onClick={handleReject} disabled={!!actionLoading}
              className="flex-1 py-2 rounded-xl bg-surface-3/60 hover:bg-surface-3 text-ink-soft text-xs font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-60">
              {actionLoading === "reject" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              Reject
            </button>
          </>
        )}

        {request.status === "Approved" && isManager && (
          <button onClick={onAssign}
            className="flex-1 py-2 rounded-xl bg-surface-3 hover:bg-surface-3 text-ink-soft text-xs font-semibold transition-all flex items-center justify-center gap-1.5">
            <UserCheck size={12} /> Assign Technician
          </button>
        )}

        {request.status === "In Progress" && isManager && (
          <button onClick={onResolve}
            className="flex-1 py-2 rounded-xl bg-success/20 hover:bg-success/30 text-success border border-success/30 text-xs font-semibold transition-all flex items-center justify-center gap-1.5">
            <CheckCircle2 size={12} /> Mark as Resolved
          </button>
        )}

        {request.status === "Resolved" && (
          <button disabled
            className="flex-1 py-2 rounded-xl bg-surface-3/50 text-ink-faint text-xs font-semibold cursor-not-allowed flex items-center justify-center gap-1.5">
            <CheckCircle2 size={12} /> Closed
          </button>
        )}

        {request.status === "Rejected" && (
          <button disabled
            className="flex-1 py-2 rounded-xl bg-danger/8 text-danger text-xs font-semibold cursor-not-allowed flex items-center justify-center gap-1.5">
            <X size={12} /> Rejected
          </button>
        )}

        {request.status === "Pending" && !isManager && (
          <button disabled
            className="flex-1 py-2 rounded-xl bg-warning/8 text-warning text-xs cursor-not-allowed flex items-center justify-center gap-1.5">
            <Clock size={12} /> Awaiting Approval
          </button>
        )}
      </div>
    </motion.div>
  );
};

// ─────────────────────────────────────────────────────────────
// MAIN PAGE COMPONENT
// ─────────────────────────────────────────────────────────────
type FilterTab = "All" | "Pending" | "Approved" | "In Progress" | "Resolved";

const Maintenance = ({
  userRole = "ASSET_MANAGER",
  currentUser = "Current User",
}: MaintenanceProps) => {

  const [requests,     setRequests]     = useState<MaintenanceRequest[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [dataError,    setDataError]    = useState<string | null>(null);
  const [search,       setSearch]       = useState("");
  const [activeTab,    setActiveTab]    = useState<FilterTab>("All");
  const [toast,        setToast]        = useState<{ msg: string; type: string } | null>(null);
  const [exporting,    setExporting]    = useState(false);

  const [showRaise,      setShowRaise]      = useState(false);
  const [showAssign,     setShowAssign]     = useState(false);
  const [showResolve,    setShowResolve]    = useState(false);
  const [activeRequest,  setActiveRequest]  = useState<MaintenanceRequest | null>(null);

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadRequests = async () => {
    setLoading(true);
    setDataError(null);
    const isManager = userRole === "ADMIN" || userRole === "ASSET_MANAGER";
    try {
      const data = await maintenanceService.getAll(!isManager);
      setRequests(data);
    } catch (err) {
      setDataError(
        err instanceof Error
          ? err.message
          : "Failed to load maintenance requests. Check that the backend is running.",
      );
    } finally {
      setLoading(false);
    }
  };

  // The first load depends only on the role, which never changes while the
  // view is open — so it runs once, on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadRequests(); }, []);

  const filtered = useMemo(() => {
    return requests.filter(r => {
      const matchTab = activeTab === "All" || r.status === activeTab;
      const matchSearch = !search ||
        r.assetName.toLowerCase().includes(search.toLowerCase()) ||
        r.assetTag.toLowerCase().includes(search.toLowerCase()) ||
        r.reqId.toLowerCase().includes(search.toLowerCase()) ||
        r.issue.toLowerCase().includes(search.toLowerCase());
      return matchTab && matchSearch;
    });
  }, [requests, activeTab, search]);

  const counts = useMemo(() => ({
    All:           requests.length,
    Pending:       requests.filter(r => r.status === "Pending").length,
    Approved:      requests.filter(r => r.status === "Approved").length,
    "In Progress": requests.filter(r => r.status === "In Progress").length,
    Resolved:      requests.filter(r => r.status === "Resolved").length,
  }), [requests]);

  const handleApprove = async (req: MaintenanceRequest) => {
    const res = await maintenanceService.approve(req.id);
    if (!res.success) {
      showToast(res.error, "error");
      return;
    }
    setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: "Approved" } : r));
    showToast(`${req.assetName} approved for maintenance`);
  };

  // Rejecting a request is not undoable, so it asks first.
  const [rejectTarget, setRejectTarget] = useState<MaintenanceRequest | null>(null);

  const handleReject = async (req: MaintenanceRequest) => {
    const res = await maintenanceService.reject(req.id);
    if (!res.success) {
      showToast(res.error, "error");
      return;
    }
    setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: "Rejected" } : r));
    showToast(`Request ${req.reqId} rejected`, "warning");
  };

  const handleAssignSuccess = (technicianName: string) => {
    if (!activeRequest) return;
    setRequests(prev => prev.map(r =>
      r.id === activeRequest.id ? { ...r, status: "In Progress" as Status, technician: technicianName } : r
    ));
    setShowAssign(false);
    setActiveRequest(null);
    showToast(`Technician ${technicianName} assigned — status set to In Progress`);
  };

  const handleResolveSuccess = () => {
    if (!activeRequest) return;
    setRequests(prev => prev.map(r =>
      r.id === activeRequest.id ? { ...r, status: "Resolved" as Status } : r
    ));
    setShowResolve(false);
    setActiveRequest(null);
    showToast(`${activeRequest.assetName} marked as Resolved — asset returned to Available`);
  };

  const handleExportPdf = () => {
    setExporting(true);
    setTimeout(() => {
      maintenanceService.exportPdf(filtered);
      setExporting(false);
      showToast("PDF report generated successfully");
    }, 600);
  };

  const TABS: FilterTab[] = ["All", "Pending", "Approved", "In Progress", "Resolved"];

  return (
    <div className="w-full">
      <Toast toast={toast} />

      <RaiseRequestModal
        open={showRaise}
        onClose={() => setShowRaise(false)}
        currentUser={currentUser}
        onSuccess={(req) => {
          setRequests(prev => [req, ...prev]);
          setShowRaise(false);
          showToast(`Request ${req.reqId} raised — pending approval`);
        }}
      />
      <AssignTechnicianModal
        open={showAssign}
        request={activeRequest}
        onClose={() => { setShowAssign(false); setActiveRequest(null); }}
        onSuccess={handleAssignSuccess}
      />
      <ResolveModal
        open={showResolve}
        request={activeRequest}
        onClose={() => { setShowResolve(false); setActiveRequest(null); }}
        onSuccess={handleResolveSuccess}
      />

      {/* HEADER */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink">Maintenance Management</h1>
          <p className="text-sm text-ink-subtle mt-0.5">Track repair requests, approvals, and resolution workflows.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportPdf}
            disabled={exporting || filtered.length === 0}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-line bg-surface text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all disabled:opacity-50"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Export PDF
          </button>
          <button
            onClick={() => setShowRaise(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all shadow-lg shadow-blue-600/20"
          >
            <Plus size={15} /> Raise Request
          </button>
        </div>
      </div>

      {/* FILTER TABS + SEARCH */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center bg-surface border border-line rounded-xl p-1 gap-0.5">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5
                ${activeTab === tab
                  ? "bg-info text-white shadow-sm"
                  : "text-ink-subtle hover:text-ink"}`}
            >
              {tab}
              {counts[tab] > 0 && activeTab !== tab && (
                <span className="text-[10px] bg-surface-3/60 px-1.5 py-0.5 rounded-full">{counts[tab]}</span>
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by asset, ID, or issue…"
            className="bg-surface border border-line rounded-xl pl-9 pr-10 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-info/50 transition-colors w-72"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
              <X size={13} className="text-ink-subtle hover:text-ink" />
            </button>
          )}
        </div>
      </div>

      {/* DATA ERROR BANNER */}
      {dataError && (
        <div className="flex items-center gap-3 bg-danger/10 border border-danger/30 rounded-2xl px-5 py-3 mb-6">
          <AlertTriangle size={16} className="text-danger flex-shrink-0" />
          <p className="text-sm text-danger flex-1">{dataError}</p>
          <button
            onClick={loadRequests}
            className="text-xs bg-danger/20 hover:bg-danger/30 text-danger border border-danger/30 px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* CARDS GRID */}
      {loading ? (
        <div className="flex items-center justify-center py-20 gap-2 text-ink-subtle">
          <Loader2 size={22} className="animate-spin text-info" />
          <span>Loading maintenance requests…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-ink-subtle">
          <Wrench size={40} className="opacity-20" />
          <p className="text-sm font-medium">No requests found</p>
          <p className="text-xs">Try a different filter or raise a new request</p>
          <button onClick={() => setShowRaise(true)}
            className="mt-2 flex items-center gap-1.5 text-sm text-info hover:underline">
            <Plus size={14} /> Raise Request
          </button>
        </div>
      ) : (
        <motion.div layout className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout">
            {filtered.map((req, i) => (
              <MaintenanceCard
                key={req.id}
                request={req}
                userRole={userRole}
                delay={i * 0.05}
                onApprove={() => handleApprove(req)}
                onReject={() => setRejectTarget(req)}
                onAssign={() => { setActiveRequest(req); setShowAssign(true); }}
                onResolve={() => { setActiveRequest(req); setShowResolve(true); }}
                onExportSingle={() => maintenanceService.exportPdf([req])}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {!loading && filtered.length > 0 && (
        <p className="text-center text-xs text-ink mt-6">
          Showing {filtered.length} of {requests.length} requests
        </p>
      )}

      {/* Rejecting a maintenance request — ask first */}
      <ConfirmDialog
        open={!!rejectTarget}
        title="Reject this request?"
        message={
          rejectTarget
            ? `The request for ${rejectTarget.assetName} (${rejectTarget.reqId}) will be declined and the employee will be told.`
            : ""
        }
        confirmLabel="Reject request"
        destructive
        onCancel={() => setRejectTarget(null)}
        onConfirm={() => {
          if (!rejectTarget) return;
          const req = rejectTarget;
          setRejectTarget(null);
          void handleReject(req);
        }}
      />
    </div>
  );
};

export default Maintenance;
