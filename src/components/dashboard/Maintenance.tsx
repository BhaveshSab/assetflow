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

// Backend statuses are SNAKE_CASE → the component's display statuses.
const BACKEND_STATUS: Record<string, Status> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  TECHNICIAN_ASSIGNED: "In Progress",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
};

const toRequest = (r: any): MaintenanceRequest => ({
  id: r.id,
  reqId: `REQ-${String(r.id ?? "").slice(-6).toUpperCase()}`,
  assetName: r.asset?.name ?? "Asset",
  assetTag: r.asset?.assetTag ?? "",
  issue: r.description ?? "",
  priority: r.priority ?? "MEDIUM",
  status: BACKEND_STATUS[r.status] ?? "Pending",
  requestedBy: r.raisedBy?.name ?? "—",
  raisedOn: r.createdAt ? r.createdAt.slice(0, 10) : "",
  technician: r.technicianName ?? undefined,
  photo: r.photoUrl ?? undefined,
});

const maintenanceService = {
  getAll: async (mine = false): Promise<MaintenanceRequest[]> => {
    const path = mine ? "/maintenance?mine=true" : "/maintenance";
    const data = await apiGet<{ items: Array<Record<string, any>> }>(path);
    return (data.items ?? []).map(toRequest);
  },

  raiseRequest: async (payload: RaiseRequestPayload) => {
    const created = await apiSend<Record<string, any>>("/maintenance", "POST", {
      assetId: payload.assetId,
      description: payload.issue,
      priority: payload.priority,
      photoUrl: payload.photo ?? undefined,
    });
    return toRequest(created);
  },

  approve: async (id: string) => {
    try {
      await apiSend(`/maintenance/${id}/approve`, "POST", {});
      return true;
    } catch { return false; }
  },

  reject: async (id: string) => {
    try {
      await apiSend(`/maintenance/${id}/reject`, "POST", {});
      return true;
    } catch { return false; }
  },

  assignTechnician: async (id: string, technicianName: string) => {
    try {
      await apiSend(`/maintenance/${id}/assign`, "POST", { technicianName });
      return true;
    } catch { return false; }
  },

  resolve: async (id: string, notes: string) => {
    try {
      await apiSend(`/maintenance/${id}/resolve`, "POST", {
        resolutionNotes: notes || undefined,
      });
      return true;
    } catch { return false; }
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
  Pending:       { color: "bg-amber-500/20 text-amber-400 border-amber-500/30",         icon: Clock        },
  Approved:      { color: "bg-blue-500/20 text-blue-400 border-blue-500/30",            icon: CheckCircle2 },
  "In Progress": { color: "bg-purple-500/20 text-purple-400 border-purple-500/30",      icon: Activity     },
  Resolved:      { color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",   icon: CheckCircle2 },
  Rejected:      { color: "bg-red-500/20 text-red-400 border-red-500/30",               icon: X            },
};

const priorityConfig: Record<Priority, { color: string; bg: string }> = {
  HIGH:   { color: "text-red-400",     bg: "bg-red-500/15 border border-red-500/30"     },
  MEDIUM: { color: "text-amber-400",   bg: "bg-amber-500/15 border border-amber-500/30" },
  LOW:    { color: "text-emerald-400", bg: "bg-emerald-500/15 border border-emerald-500/30" },
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
          ${toast.type === "error"   ? "bg-red-950 border-red-500/40 text-red-300"
          : toast.type === "warning" ? "bg-amber-950 border-amber-500/40 text-amber-300"
          :                            "bg-emerald-950 border-emerald-500/40 text-emerald-300"}`}
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
    maintenanceService.getAssets().then(setAssets).finally(() => setFetching(false));
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
    } catch (err: any) {
      setSubmitError(err?.message ?? "Failed to raise request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = (field: string) =>
    `w-full bg-[#0f111a] border rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none transition-all
    ${errors[field] ? "border-red-500/60" : "border-zinc-700 focus:border-blue-500/60"}`;

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
            className="bg-[#1a1d2e] border border-zinc-700/80 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[95vh] flex flex-col"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/15 flex items-center justify-center">
                  <Wrench size={17} className="text-amber-400" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-white">Raise Maintenance Request</h2>
                  <p className="text-[11px] text-zinc-500">Report a broken or faulty asset for repair</p>
                </div>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-700/50 transition-colors">
                <X size={16} className="text-zinc-400" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
              {/* Global submit error */}
              {submitError && (
                <div className="flex items-center gap-2.5 bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-2.5 text-sm text-red-400">
                  <AlertCircle size={14} className="flex-shrink-0" /> {submitError}
                </div>
              )}

              {/* Asset Selector */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Asset <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAssetOpen(o => !o)}
                    className={`w-full flex items-center gap-2 px-3.5 py-2.5 rounded-xl border text-left transition-all text-sm
                      ${errors.asset ? "border-red-500/60" : assetOpen ? "border-blue-500/60" : "border-zinc-700 hover:border-zinc-600"}
                      bg-[#0f111a]`}
                  >
                    <Package size={14} className="text-zinc-500 flex-shrink-0" />
                    <span className={form.asset ? "text-white flex-1" : "text-zinc-600 flex-1"}>
                      {form.asset ? `${form.asset.name} (${form.asset.assetTag})` : "Search and select asset…"}
                    </span>
                    <ChevronDown size={13} className={`text-zinc-500 transition-transform ${assetOpen ? "rotate-180" : ""}`} />
                  </button>

                  <AnimatePresence>
                    {assetOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                        className="absolute z-50 top-full mt-1.5 w-full bg-[#1a1d2e] border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
                      >
                        <div className="p-2 border-b border-zinc-800">
                          <div className="relative">
                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                            <input autoFocus value={assetSearch} onChange={e => setAssetSearch(e.target.value)}
                              placeholder="Search assets…"
                              className="w-full bg-[#0f111a] border border-zinc-700 rounded-lg pl-7 pr-3 py-1.5 text-xs text-white outline-none focus:border-blue-500/50" />
                          </div>
                        </div>
                        <div className="max-h-44 overflow-y-auto">
                          {fetching ? (
                            <div className="py-4 text-center text-xs text-zinc-500 flex items-center justify-center gap-1.5">
                              <Loader2 size={13} className="animate-spin" /> Loading…
                            </div>
                          ) : filteredAssets.length === 0 ? (
                            <div className="py-4 text-center text-xs text-zinc-500">No assets found</div>
                          ) : filteredAssets.map(a => (
                            <button key={a.id} type="button"
                              onClick={() => { set("asset", a); setAssetOpen(false); setAssetSearch(""); }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-zinc-700/40 transition-colors text-left"
                            >
                              <Package size={13} className="text-blue-400 flex-shrink-0" />
                              <div>
                                <p className="text-sm text-white">{a.name}</p>
                                <p className="text-[11px] text-zinc-500">{a.assetTag}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                {errors.asset && <p className="text-red-400 text-[11px] mt-1 flex items-center gap-1"><AlertTriangle size={10} />{errors.asset}</p>}
              </div>

              {/* Issue Description */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Issue Description <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <FileText size={14} className="absolute left-3.5 top-3 text-zinc-500" />
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
                    ? <p className="text-red-400 text-[11px] flex items-center gap-1"><AlertTriangle size={10} />{errors.issue}</p>
                    : <span />}
                  <span className="text-[11px] text-zinc-600 ml-auto">{form.issue.length}/500</span>
                </div>
              </div>

              {/* Priority */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">Priority</label>
                <div className="flex gap-2">
                  {(["HIGH", "MEDIUM", "LOW"] as Priority[]).map(p => {
                    const cfg = priorityConfig[p];
                    return (
                      <button key={p} type="button" onClick={() => set("priority", p)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl border text-xs font-bold transition-all
                          ${form.priority === p ? `${cfg.bg} ${cfg.color}` : "border-zinc-700 text-zinc-500 hover:border-zinc-600"}`}
                      >
                        <AlertTriangle size={11} /> {p}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Photo upload */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Attach Photo (optional)</label>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-dashed border-zinc-700 hover:border-zinc-500 transition-colors text-sm text-zinc-500 hover:text-zinc-300"
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
                  className="flex items-center gap-2.5 bg-red-950/30 border border-red-500/25 rounded-xl px-4 py-2.5"
                >
                  <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
                  <p className="text-[11px] text-red-300">
                    HIGH priority requests must be approved by an Asset Manager before work begins.
                    Asset will be marked <span className="font-bold">Under Maintenance</span> on approval.
                  </p>
                </motion.div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-zinc-800 flex gap-3 flex-shrink-0">
              <button onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all">
                Cancel
              </button>
              <button onClick={handleSubmit} disabled={submitting}
                className="flex-1 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50">
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

  useEffect(() => {
    if (!open) return;
    setSelected("");
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
    await maintenanceService.assignTechnician(request.id, selected);
    setSubmitting(false);
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
            className="bg-[#1a1d2e] border border-zinc-700 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-blue-500/15 flex items-center justify-center">
                  <UserCheck size={15} className="text-blue-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Assign Technician</h3>
                  <p className="text-[11px] text-zinc-500">{request.assetName}</p>
                </div>
              </div>
              <button onClick={onClose}><X size={15} className="text-zinc-400 hover:text-white" /></button>
            </div>

            <div className="p-5">
              <p className="text-xs text-zinc-500 mb-3">
                Choose who will work on this request — the name is recorded on the request.
              </p>
              <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                {loadingEmps ? (
                  <div className="py-6 flex items-center justify-center gap-2 text-zinc-500 text-sm">
                    <Loader2 size={14} className="animate-spin text-blue-400" />
                    Loading employees…
                  </div>
                ) : employees.length === 0 ? (
                  <div className="py-6 text-center text-xs text-zinc-600">
                    No active employees found. Create one in Organization Setup first.
                  </div>
                ) : employees.map(e => (
                  <button key={e.id} onClick={() => setSelected(e.name)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left
                      ${selected === e.name
                        ? "border-blue-500/50 bg-blue-500/10 text-white"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-white"}`}
                  >
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                      {initials(e.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{e.name}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{e.email}</p>
                    </div>
                    {selected === e.name && <Check size={14} className="text-blue-400" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-5 py-4 border-t border-zinc-800 flex gap-3">
              <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 transition-all">
                Cancel
              </button>
              <button onClick={handleAssign} disabled={!selected || submitting}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50">
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

  const handleResolve = async () => {
    if (!request) return;
    setSubmitting(true);
    await maintenanceService.resolve(request.id, notes);
    setSubmitting(false);
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
            className="bg-[#1a1d2e] border border-zinc-700 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                  <CheckCircle2 size={15} className="text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Mark as Resolved</h3>
                  <p className="text-[11px] text-zinc-500">{request.assetName}</p>
                </div>
              </div>
              <button onClick={onClose}><X size={15} className="text-zinc-400 hover:text-white" /></button>
            </div>

            <div className="p-5">
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Resolution Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="What was done to fix the issue?"
                rows={3}
                className="w-full bg-[#0f111a] border border-zinc-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-emerald-500/50 transition-colors resize-none" />
              <p className="text-[11px] text-zinc-600 mt-2">
                The asset status will automatically revert to <span className="text-white font-medium">Available</span> after resolution.
              </p>
            </div>

            <div className="px-5 py-4 border-t border-zinc-800 flex gap-3">
              <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 transition-all">
                Cancel
              </button>
              <button onClick={handleResolve} disabled={submitting}
                className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50">
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
    className="absolute right-0 top-8 z-50 w-44 bg-[#1a1d2e] border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
    onClick={e => e.stopPropagation()}
  >
    {[
      { label: "View Details",   icon: ClipboardList, action: () => {} },
      { label: "Export PDF",     icon: Download,      action: onExport  },
    ].map(({ label, icon: Icon, action }) => (
      <button key={label} onClick={() => { action(); onClose(); }}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-zinc-400 hover:bg-zinc-700/50 hover:text-white transition-colors">
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
      className="bg-[#1a1d2e] border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-4 hover:border-zinc-700 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-white leading-tight">{request.assetName}</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">{request.assetTag} • {request.reqId}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusBadge status={request.status} />
          <div className="relative">
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
              className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
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

      <div className="bg-[#0f111a] border border-zinc-800 rounded-xl p-3.5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Issue Description</span>
          <PriorityBadge priority={request.priority} />
        </div>
        <p className="text-xs text-zinc-300 leading-relaxed">{request.issue}</p>
      </div>

      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5"><User size={11} /> {request.requestedBy}</span>
        <span className="flex items-center gap-1.5"><Calendar size={11} /> {request.raisedOn}</span>
      </div>

      {request.technician && (
        <div className="flex items-center gap-1.5 text-[11px] text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-1.5">
          <UserCheck size={11} /> Technician: {request.technician}
        </div>
      )}

      <div className="flex gap-2">
        {request.status === "Pending" && isManager && (
          <>
            <button onClick={handleApprove} disabled={!!actionLoading}
              className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-60">
              {actionLoading === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Approve
            </button>
            <button onClick={handleReject} disabled={!!actionLoading}
              className="flex-1 py-2 rounded-xl bg-zinc-700/60 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-60">
              {actionLoading === "reject" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              Reject
            </button>
          </>
        )}

        {request.status === "Approved" && isManager && (
          <button onClick={onAssign}
            className="flex-1 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition-all flex items-center justify-center gap-1.5">
            <UserCheck size={12} /> Assign Technician
          </button>
        )}

        {request.status === "In Progress" && isManager && (
          <button onClick={onResolve}
            className="flex-1 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 text-xs font-semibold transition-all flex items-center justify-center gap-1.5">
            <CheckCircle2 size={12} /> Mark as Resolved
          </button>
        )}

        {request.status === "Resolved" && (
          <button disabled
            className="flex-1 py-2 rounded-xl bg-zinc-800/50 text-zinc-600 text-xs font-semibold cursor-not-allowed flex items-center justify-center gap-1.5">
            <CheckCircle2 size={12} /> Closed
          </button>
        )}

        {request.status === "Rejected" && (
          <button disabled
            className="flex-1 py-2 rounded-xl bg-red-950/30 text-red-500 text-xs font-semibold cursor-not-allowed flex items-center justify-center gap-1.5">
            <X size={12} /> Rejected
          </button>
        )}

        {request.status === "Pending" && !isManager && (
          <button disabled
            className="flex-1 py-2 rounded-xl bg-amber-950/30 text-amber-500 text-xs cursor-not-allowed flex items-center justify-center gap-1.5">
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

  useEffect(() => { loadRequests(); }, []);

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
    await maintenanceService.approve(req.id);
    setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: "Approved" } : r));
    showToast(`${req.assetName} approved for maintenance`);
  };

  const handleReject = async (req: MaintenanceRequest) => {
    await maintenanceService.reject(req.id);
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
          <h1 className="text-2xl font-bold text-white">Maintenance Management</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Track repair requests, approvals, and resolution workflows.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportPdf}
            disabled={exporting || filtered.length === 0}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-zinc-700 bg-[#1a1d2e] text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all disabled:opacity-50"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Export PDF
          </button>
          <button
            onClick={() => setShowRaise(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all shadow-lg shadow-blue-600/20"
          >
            <Plus size={15} /> Raise Request
          </button>
        </div>
      </div>

      {/* FILTER TABS + SEARCH */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center bg-[#1a1d2e] border border-zinc-800 rounded-xl p-1 gap-0.5">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5
                ${activeTab === tab
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-zinc-500 hover:text-zinc-200"}`}
            >
              {tab}
              {counts[tab] > 0 && activeTab !== tab && (
                <span className="text-[10px] bg-zinc-700/60 px-1.5 py-0.5 rounded-full">{counts[tab]}</span>
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by asset, ID, or issue…"
            className="bg-[#1a1d2e] border border-zinc-800 rounded-xl pl-9 pr-10 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/50 transition-colors w-72"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
              <X size={13} className="text-zinc-500 hover:text-white" />
            </button>
          )}
        </div>
      </div>

      {/* DATA ERROR BANNER */}
      {dataError && (
        <div className="flex items-center gap-3 bg-red-950/40 border border-red-500/30 rounded-2xl px-5 py-3 mb-6">
          <AlertTriangle size={16} className="text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300 flex-1">{dataError}</p>
          <button
            onClick={loadRequests}
            className="text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* CARDS GRID */}
      {loading ? (
        <div className="flex items-center justify-center py-20 gap-2 text-zinc-500">
          <Loader2 size={22} className="animate-spin text-blue-400" />
          <span>Loading maintenance requests…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-zinc-500">
          <Wrench size={40} className="opacity-20" />
          <p className="text-sm font-medium">No requests found</p>
          <p className="text-xs">Try a different filter or raise a new request</p>
          <button onClick={() => setShowRaise(true)}
            className="mt-2 flex items-center gap-1.5 text-sm text-blue-400 hover:underline">
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
                onReject={() => handleReject(req)}
                onAssign={() => { setActiveRequest(req); setShowAssign(true); }}
                onResolve={() => { setActiveRequest(req); setShowResolve(true); }}
                onExportSingle={() => maintenanceService.exportPdf([req])}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {!loading && filtered.length > 0 && (
        <p className="text-center text-xs text-zinc-700 mt-6">
          Showing {filtered.length} of {requests.length} requests
        </p>
      )}
    </div>
  );
};

export default Maintenance;
