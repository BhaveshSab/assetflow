import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRightLeft,
  AlertCircle,
  User,
  Calendar,
  CheckCircle2,
  XCircle,
  Search,
  Plus,
  Loader2,
  X,
  Bell,
  Check,
  Send,
} from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import AllocateAssetModal from "@/components/dashboard/AllocateAssetModal";
import { ConfirmDialog } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/utils";
import { fieldStr, type ApiRecord } from "@/types/api";

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

interface Allocation {
  id: string;
  _assetId?: string;
  holderId?: string;
  assetName: string;
  assetTag: string;
  assignee: string;
  role: string;
  returnDate: string;
  status: string;
  avatar: string;
  requester?: string;
}

interface Toast { msg: string; type: string; }

// ==========================================
// API SERVICE (real backend)
// ==========================================
const initials = (name: string) =>
  name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "—";

const allocationApi = {
  returnAsset: async (
    id: string,
    payload?: { checkInNotes?: string; conditionOnReturn?: string },
  ) => {
    try {
      await apiSend(`/allocations/${id}/return`, "POST", {
        checkInNotes: payload?.checkInNotes || undefined,
        conditionOnReturn: payload?.conditionOnReturn || undefined,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err, "Return failed") };
    }
  },
  transferAsset: async (assetId: string, toUserId: string, reason?: string) => {
    try {
      await apiSend("/transfers", "POST", {
        assetId,
        toUserId,
        reason: reason || "Transfer requested from Allocations & Transfers",
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err, "Transfer failed") };
    }
  },
  getEmployees: async (): Promise<Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>> => {
    // Any authenticated user can fetch the minimal directory (id/name/email);
    // role is omitted by the endpoint, so it's filled with a neutral value.
    const data = await apiGet<Array<{
      id: string;
      name: string;
      email: string;
    }>>("/org/employees/directory");
    return (Array.isArray(data) ? data : []).map((e) => ({ ...e, role: "Employee" }));
  },
  approveTransfer: async (id: string) => {
    try {
      await apiSend(`/transfers/${id}/approve`, "POST");
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err, "The request could not be sent.") };
    }
  },
  rejectTransfer: async (id: string) => {
    try {
      await apiSend(`/transfers/${id}/reject`, "POST");
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err, "The request could not be sent.") };
    }
  },
  sendPing: async (allocationId: string) => {
    try {
      await apiSend("/notifications/ping", "POST", { allocationId });
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err, "The request could not be sent.") };
    }
  },
};

interface AllocationsTransfersProps {
  userRole?: "ADMIN" | "ASSET_MANAGER" | "DEPARTMENT_HEAD" | "EMPLOYEE";
  currentUserId?: string;
  currentUserName?: string;
}

// ==========================================
// RETURN ASSET MODAL (captures notes + condition on return)
// ==========================================
const RETURN_CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
  { value: "POOR", label: "Poor" },
  { value: "DAMAGED", label: "Damaged" },
];

const ReturnAssetModal = ({
  open,
  asset,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  asset: Allocation | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (payload: { checkInNotes?: string; conditionOnReturn?: string }) => void;
}) => {
  const [condition, setCondition] = useState("GOOD");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setCondition("GOOD");
      setNotes("");
    }
  }, [open]);

  if (!open || !asset) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.93, opacity: 0, y: 24 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.93, opacity: 0, y: 24 }}
          transition={{ type: "spring", damping: 26, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-surface border border-line/80 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-success/15 flex items-center justify-center">
                <CheckCircle2 size={17} className="text-success" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-ink">Return Asset</h2>
                <p className="text-[11px] text-ink-subtle">
                  {asset.assetName} &middot; {asset.assetTag}
                </p>
              </div>
            </div>
            <button aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
              <X size={15} className="text-ink-muted" />
            </button>
          </div>

          <div className="p-5 space-y-5">
            <div>
              <label className="block text-xs font-semibold text-ink-muted mb-2 uppercase tracking-wide">
                Condition on return
              </label>
              <div className="flex flex-wrap gap-2">
                {RETURN_CONDITIONS.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setCondition(c.value)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                      condition === c.value
                        ? "bg-success/15 border-success/40 text-success"
                        : "border-line text-ink-subtle hover:border-line-strong hover:text-ink-soft"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-muted mb-1.5 uppercase tracking-wide">
                Check-in notes (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Remarks about the asset's condition, missing accessories, damage…"
                className="w-full bg-canvas border border-line/80 rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-success/60 transition-all resize-none"
              />
            </div>
          </div>

          <div className="px-5 py-4 border-t border-line flex gap-3">
            <button
              aria-label="Close"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() =>
                onConfirm({
                  checkInNotes: notes || undefined,
                  conditionOnReturn: condition,
                })
              }
              disabled={submitting}
              className="flex-1 py-2.5 rounded-xl bg-success hover:bg-success text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CheckCircle2 size={14} />
              )}
              {submitting ? "Returning…" : "Confirm Return"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

// ==========================================
// TRANSFER ASSET MODAL (pick employee + reason)
// ==========================================
const TransferAssetModal = ({
  open,
  asset,
  submitting,
  currentUserId,
  onClose,
  onConfirm,
}: {
  open: boolean;
  asset: Allocation | null;
  submitting: boolean;
  currentUserId?: string;
  onClose: () => void;
  onConfirm: (toUserId: string, reason?: string) => void;
}) => {
  const [employees, setEmployees] = useState<Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>>([]);
  const [loadingEmps, setLoadingEmps] = useState(false);
  const [empError, setEmpError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open || !asset) return;
    setQuery("");
    setSelected(null);
    setReason("");
    setEmpError("");
    setLoadingEmps(true);
    allocationApi
      .getEmployees()
      .then((emps) =>
        setEmployees(
          emps.filter(
            (e) => e.id !== asset.holderId && e.id !== currentUserId,
          ),
        ),
      )
      .catch((err: unknown) => {
        setEmployees([]);
        setEmpError(errorMessage(err, "Failed to load employees"));
      })
      .finally(() => setLoadingEmps(false));
  }, [open, asset, currentUserId]);

  if (!open || !asset) return null;

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
        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.93, opacity: 0, y: 24 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.93, opacity: 0, y: 24 }}
          transition={{ type: "spring", damping: 26, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-surface border border-line/80 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-info/15 flex items-center justify-center">
                <ArrowRightLeft size={16} className="text-info" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-ink">Transfer Asset</h2>
                <p className="text-[11px] text-ink-subtle">
                  {asset.assetName} &middot; {asset.assetTag}
                </p>
              </div>
            </div>
            <button aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
              <X size={15} className="text-ink-muted" />
            </button>
          </div>

          <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
            <div>
              <label className="block text-xs font-semibold text-ink-muted mb-2 uppercase tracking-wide">
                Transfer to
              </label>
              <div className="relative mb-2">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                <input
                  type="text"
                  placeholder="Search employees…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full bg-canvas border border-line/80 rounded-xl pl-9 pr-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-info/60 transition-all"
                />
              </div>
              <div className="max-h-44 overflow-y-auto rounded-xl border border-line divide-y divide-line/50">
                {loadingEmps ? (
                  <div className="py-6 flex items-center justify-center gap-2 text-ink-subtle text-sm">
                    <Loader2 size={14} className="animate-spin text-info" />
                    Loading employees…
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="py-6 text-center text-ink-faint text-sm">
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
                        selected === e.id
                          ? "bg-info/10"
                          : "hover:bg-surface-3/50"
                      }`}
                    >
                      <div className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center text-[10px] font-bold text-ink flex-shrink-0">
                        {initials(e.name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink truncate">
                          {e.name}
                        </p>
                        <p className="text-[11px] text-ink-subtle truncate">{e.email}</p>
                      </div>
                      {selected === e.id && (
                        <Check size={14} className="text-info flex-shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-muted mb-1.5 uppercase tracking-wide">
                Reason (optional)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Why is this asset being transferred?"
                className="w-full bg-canvas border border-line/80 rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-info/60 transition-all resize-none"
              />
            </div>
          </div>

          <div className="px-5 py-4 border-t border-line flex gap-3">
            <button
              aria-label="Close"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => selected && onConfirm(selected, reason || undefined)}
              disabled={submitting || !selected}
              className="flex-1 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50"
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

export default function AllocationsTransfers({
  userRole = "EMPLOYEE",
  currentUserId,
  currentUserName,
}: AllocationsTransfersProps) {
  const isManager =
    userRole === "ADMIN" ||
    userRole === "ASSET_MANAGER" ||
    userRole === "DEPARTMENT_HEAD";
  // Only ADMIN / ASSET_MANAGER can create allocations (POST /allocations is
  // @Roles(ADMIN, ASSET_MANAGER)) — dept heads must not see the button.
  const canAllocate = userRole === "ADMIN" || userRole === "ASSET_MANAGER";

  const [allocations, setAllocations] = useState<Allocation[]>([]);
  // The transfer the manager is about to reject — the rejection is only
  // sent after the confirmation, never on the first click.
  const [rejectTarget, setRejectTarget] = useState<Allocation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [showAllocate, setShowAllocate] = useState(false);
  const [returnTarget, setReturnTarget] = useState<Allocation | null>(null);
  const [transferTarget, setTransferTarget] = useState<Allocation | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, string | null>>({});

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ==========================================
  // BACKEND INTEGRATION: Fetch Data
  // ==========================================
  const loadAllocations = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Managers see ALL allocations + pending transfers; employees only see
      // their own (holder or allocator) via the dedicated /allocations/my endpoint.
      const [allocData, transferData] = await Promise.all([
        apiGet<{ items: ApiRecord[] }>(isManager ? "/allocations" : "/allocations/my"),
        isManager
          ? apiGet<{ items: ApiRecord[] }>("/transfers?status=REQUESTED")
          : Promise.resolve({ items: [] as ApiRecord[] }),
      ]);
      const now = Date.now();

      const allocCards: Allocation[] = (allocData.items ?? []).map((a) => {
        const expectedIso = fieldStr(a, "", "expectedReturnDate");
        const expected = expectedIso ? new Date(expectedIso).getTime() : null;
        const status = fieldStr(a, "", "status");
        const isOverdue =
          status === "ACTIVE" && expected !== null && expected < now;
        const holder =
          fieldStr(a, "", "holderUser", "name") ||
          fieldStr(a, "", "department", "name") ||
          "—";
        return {
          id: fieldStr(a, "", "id"),
          _assetId: fieldStr(a, "", "assetId"),
          holderId: fieldStr(a, "", "holderUserId") || undefined,
          assetName: fieldStr(a, "Asset", "asset", "name"),
          assetTag: fieldStr(a, "", "asset", "assetTag"),
          assignee: holder,
          role:
            fieldStr(a, "", "holderUser", "role") ||
            (fieldStr(a, "", "departmentId") ? "Department" : "—"),
          returnDate: expectedIso ? expectedIso.slice(0, 10) : "—",
          status:
            status === "RETURNED"
              ? "Returned"
              : isOverdue
                ? "Overdue"
                : "Allocated",
          avatar: initials(holder),
        };
      });

      const transferCards: Allocation[] = (transferData.items ?? []).map((t) => {
        const createdIso = fieldStr(t, "", "createdAt");
        return {
          id: fieldStr(t, "", "id"),
          assetName: fieldStr(t, "Asset", "asset", "name"),
          assetTag: fieldStr(t, "", "asset", "assetTag"),
          assignee:
            fieldStr(t, "", "toUser", "name") ||
            fieldStr(t, "", "toDepartment", "name") ||
            "—",
          role: "Pending",
          returnDate: createdIso ? createdIso.slice(0, 10) : "—",
          status: "Transfer Pending",
          requester: fieldStr(t, "", "requestedBy", "name"),
          avatar: "↔",
        };
      });

      setAllocations([...allocCards, ...transferCards]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong fetching allocations.");
    } finally {
      setIsLoading(false);
    }
  }, [isManager]);

  useEffect(() => { void loadAllocations(); }, [loadAllocations]);

  // ── Action Handlers ──
  // ── Open the return/transfer modals ──
  const handleReturn = (item: Allocation) => {
    setReturnTarget(item);
  };

  const handleTransfer = (item: Allocation) => {
    if (!item._assetId) {
      showToast("This asset has no allocation to transfer.", "error");
      return;
    }
    setTransferTarget(item);
  };

  const submitReturn = async (payload: {
    checkInNotes?: string;
    conditionOnReturn?: string;
  }) => {
    if (!returnTarget) return;
    setActionLoading((p) => ({ ...p, [returnTarget.id]: "return" }));
    const res = await allocationApi.returnAsset(returnTarget.id, payload);
    if (res.success) {
      setAllocations((prev) => prev.filter((a) => a.id !== returnTarget.id));
      setReturnTarget(null);
      showToast("Asset returned successfully");
    } else {
      showToast(res.error ?? "Return failed. Please try again.", "error");
    }
    setActionLoading((p) => ({ ...p, [returnTarget.id]: null }));
  };

  const submitTransfer = async (toUserId: string, reason?: string) => {
    if (!transferTarget?._assetId) return;
    setActionLoading((p) => ({ ...p, [transferTarget.id]: "transfer" }));
    const res = await allocationApi.transferAsset(transferTarget._assetId, toUserId, reason);
    if (res.success) {
      // Re-read instead of flipping the allocation card's label: that card
      // carries the ALLOCATION id, and the row the manager has to approve is a
      // transfer with its own id. Relabelling left Approve/Reject sending the
      // allocation id, which answered "Transfer request not found".
      void loadAllocations();
      setTransferTarget(null);
      showToast("Transfer request submitted — pending approval");
    } else {
      showToast(res.error ?? "Transfer failed.", "error");
    }
    setActionLoading((p) => ({ ...p, [transferTarget.id]: null }));
  };

  const handleApprove = async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: "approve" }));
    const res = await allocationApi.approveTransfer(id);
    if (res.success) {
      showToast("Transfer approved — asset re-assigned");
      // Reload so the new holder's allocation card replaces the request card.
      void loadAllocations();
    } else {
      showToast(res.error ?? "Approval failed.", "error");
    }
    setActionLoading((p) => ({ ...p, [id]: null }));
  };

  const handleReject = async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: "reject" }));
    const res = await allocationApi.rejectTransfer(id);
    if (res.success) {
      setAllocations((prev) => prev.filter((a) => a.id !== id));
      showToast("Transfer rejected");
    } else {
      showToast(res.error ?? "Rejection failed.", "error");
    }
    setActionLoading((p) => ({ ...p, [id]: null }));
  };

  const handlePing = async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: "ping" }));
    const res = await allocationApi.sendPing(id);
    if (res.success) {
      showToast("Reminder sent to assignee");
    } else {
      showToast(res.error ?? "Failed to send reminder.", "error");
    }
    setActionLoading((p) => ({ ...p, [id]: null }));
  };

  // ==========================================
  // FILTERING LOGIC
  // ==========================================
  const filteredData = allocations.filter((item) => {
    const matchesSearch =
      item.assetName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.assignee.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTab =
      activeTab === "All" ? true : item.status.includes(activeTab);
    return matchesSearch && matchesTab;
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full space-y-8"
    >
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl text-sm font-medium shadow-xl border ${toast.type === "error" ? "bg-danger/25 border-danger/40 text-danger" : "bg-success/25 border-success/40 text-success"}`}
          >{toast.type === "error" ? <X size={14} className="inline mr-1.5" /> : <CheckCircle2 size={14} className="inline mr-1.5" />}{toast.msg}</motion.div>
        )}
      </AnimatePresence>
      {/* --- Page Header --- */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight">
            {isManager ? "Allocations & Transfers" : "My Allocated Assets"}
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            {isManager
              ? "Manage asset assignments and resolve conflicts"
              : currentUserName
                ? `${currentUserName.split(" ")[0]}, here are the assets currently assigned to you`
                : "Assets currently assigned to you — initiate returns or transfers"}
          </p>
        </div>
        {canAllocate && (
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setShowAllocate(true)}
            className="flex items-center gap-2 bg-info hover:bg-info text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-[0_0_20px_rgba(37,99,235,0.3)] transition-all"
          >
            <Plus size={18} />
            Allocate Asset
          </motion.button>
        )}
      </div>

      {/* --- Filters & Search Toolbar --- */}
      <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="flex p-1 bg-surface-2 border border-line/80 rounded-xl w-full md:w-auto">
          {(isManager
            ? ["All", "Allocated", "Overdue", "Transfer"]
            : ["All", "Allocated", "Overdue"]
          ).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 md:flex-none px-6 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab
                  ? "bg-surface-3 text-ink shadow-sm"
                  : "text-ink-muted hover:text-ink hover:bg-surface-3/50"
              }`}
            >
              {tab === "Transfer" ? "Pending Transfers" : tab}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
            size={16}
          />
          <input
            type="text"
            placeholder="Search assets or assignees..."
            className="w-full bg-surface-2 border border-line/80 text-ink text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:border-info/50 focus:ring-1 focus:ring-info/50 transition-all placeholder:text-ink-faint"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* --- Error State --- */}
      {error && (
        <div role="alert" className="bg-danger/10 border border-danger/20 rounded-xl p-6 flex items-center gap-4 text-danger">
          <AlertCircle size={24} />
          <p>{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="ml-auto underline text-sm hover:text-danger"
          >
            Retry
          </button>
        </div>
      )}

      {/* --- Loading Skeletons --- */}
      {isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="bg-surface-2 border border-line rounded-2xl p-6 h-64 animate-pulse flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="h-6 bg-surface-3 rounded w-1/2"></div>
                <div className="h-4 bg-surface-3 rounded w-1/3"></div>
              </div>
              <div className="h-12 bg-canvas rounded-xl w-full mt-6"></div>
              <div className="flex gap-3 mt-4">
                <div className="h-10 bg-surface-3 rounded-lg w-full"></div>
                <div className="h-10 bg-surface-3 rounded-lg w-full"></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* --- Allocations Grid --- */}
      {!isLoading && !error && (
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          <AnimatePresence>
            {filteredData.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="col-span-full flex flex-col items-center justify-center py-20 text-ink-subtle"
              >
                <Search size={48} className="mb-4 opacity-20" />
                <p>No allocations found matching your criteria.</p>
              </motion.div>
            ) : (
              filteredData.map((item) => (
                <motion.div
                  key={item.id}
                  variants={cardVariants}
                  layout
                  className={`relative overflow-hidden bg-surface-2 border rounded-2xl p-6 shadow-xl flex flex-col justify-between group ${
                    item.status === "Overdue"
                      ? "border-danger/30 shadow-[0_0_15px_rgba(239,68,68,0.05)]"
                      : item.status === "Transfer Pending"
                      ? "border-warning/30"
                      : "border-line/80 hover:border-line"
                  } transition-colors`}
                >
                  <div
                    className={`absolute top-0 right-0 w-32 h-32 blur-3xl opacity-10 rounded-full pointer-events-none transition-colors ${
                      item.status === "Overdue"
                        ? "bg-danger"
                        : item.status === "Transfer Pending"
                        ? "bg-warning"
                        : "bg-info"
                    }`}
                  ></div>

                  <div>
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="text-lg font-bold text-ink group-hover:text-info transition-colors">
                          {item.assetName}
                        </h3>
                        <p className="text-xs text-ink-subtle font-mono mt-1">
                          {item.assetTag}
                        </p>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
                          item.status === "Overdue"
                            ? "bg-danger/10 text-danger border-danger/20"
                            : item.status === "Transfer Pending"
                            ? "bg-warning/10 text-warning border-warning/20"
                            : "bg-success/10 text-success border-success/20"
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>

                    <div className="space-y-3 mt-6">
                      <div className="flex items-center gap-3 bg-canvas p-3 rounded-xl border border-line/50">
                        <div className="w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center text-xs font-bold text-ink-soft">
                          {item.avatar}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-ink">
                            {currentUserId && item.holderId === currentUserId
                              ? "You"
                              : item.assignee}
                          </p>
                          <div className="flex items-center gap-1 text-xs text-ink-subtle mt-0.5">
                            <User size={12} />
                            <span>{item.role}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-ink-muted px-1">
                        <Calendar
                          size={14}
                          className={
                            item.status === "Overdue"
                              ? "text-danger"
                              : "text-ink-subtle"
                          }
                        />
                        <span>
                          Expected Return:{" "}
                          <strong
                            className={
                              item.status === "Overdue"
                                ? "text-danger"
                                : "text-ink-soft"
                            }
                          >
                            {item.returnDate}
                          </strong>
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-line/50 flex gap-3">
                    {/* Returned — read-only */}
                    {item.status === "Returned" && (
                      <div className="w-full py-2 px-3 rounded-lg bg-surface-3/40 border border-line/50 text-center">
                        <span className="text-xs text-ink-subtle">Asset returned — no actions available</span>
                      </div>
                    )}

                    {/* Transfer Pending — managers approve/reject */}
                    {isManager && item.status === "Transfer Pending" && (
                      <div className="w-full flex gap-2">
                        <button
                          disabled={!!actionLoading[item.id]}
                          onClick={() => handleApprove(item.id)}
                          className="flex-1 bg-success/10 text-success border border-success/20 py-2 rounded-lg text-xs font-semibold flex justify-center gap-1 disabled:opacity-50"
                        >
                          {actionLoading[item.id] === "approve" ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={14} />}
                          Approve
                        </button>
                        <button
                          disabled={!!actionLoading[item.id]}
                          onClick={() => setRejectTarget(item)}
                          className="flex-1 bg-danger/10 text-danger border border-danger/20 py-2 rounded-lg text-xs font-semibold flex justify-center gap-1 disabled:opacity-50"
                        >
                          {actionLoading[item.id] === "reject" ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={14} />}
                          Reject
                        </button>
                      </div>
                    )}

                    {/* Transfer Pending — employee sees a read-only note */}
                    {!isManager && item.status === "Transfer Pending" && (
                      <div className="w-full py-2 px-3 rounded-lg bg-warning/10 border border-warning/20 text-center">
                        <span className="text-xs text-warning">Transfer pending manager approval</span>
                      </div>
                    )}

                    {/* Allocated — return + transfer */}
                    {item.status === "Allocated" && (
                      <>
                        <button
                          disabled={!!actionLoading[item.id]}
                          onClick={() => handleReturn(item)}
                          className="flex-1 bg-canvas hover:bg-surface-3 border border-line text-ink-soft py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          {actionLoading[item.id] === "return" ? <Loader2 size={13} className="animate-spin" /> : null}
                          {isManager ? "Return" : "Initiate Return"}
                        </button>
                        <button
                          disabled={!!actionLoading[item.id]}
                          onClick={() => handleTransfer(item)}
                          className="flex-1 bg-info/10 hover:bg-info/20 text-info py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          {actionLoading[item.id] === "transfer" ? <Loader2 size={13} className="animate-spin" /> : <ArrowRightLeft size={14} />}
                          {isManager ? "Transfer" : "Request Transfer"}
                        </button>
                      </>
                    )}

                    {/* Overdue — managers ping; employees return/transfer their own */}
                    {isManager && item.status === "Overdue" && (
                      <button
                        disabled={!!actionLoading[item.id]}
                        onClick={() => handlePing(item.id)}
                        className="w-full bg-danger/10 text-danger border border-danger/20 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {actionLoading[item.id] === "ping" ? <Loader2 size={13} className="animate-spin" /> : <Bell size={14} />}
                        Send Ping
                      </button>
                    )}
                    {!isManager && item.status === "Overdue" && (
                      <>
                        <button
                          disabled={!!actionLoading[item.id]}
                          onClick={() => handleReturn(item)}
                          className="flex-1 bg-canvas hover:bg-surface-3 border border-line text-ink-soft py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          {actionLoading[item.id] === "return" ? <Loader2 size={13} className="animate-spin" /> : null}
                          Initiate Return
                        </button>
                        <button
                          disabled={!!actionLoading[item.id]}
                          onClick={() => handleTransfer(item)}
                          className="flex-1 bg-info/10 hover:bg-info/20 text-info py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          {actionLoading[item.id] === "transfer" ? <Loader2 size={13} className="animate-spin" /> : <ArrowRightLeft size={14} />}
                          Request Transfer
                        </button>
                      </>
                    )}
                  </div>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Allocate Asset Modal (managers only) */}
      <AllocateAssetModal
        open={showAllocate}
        onClose={() => setShowAllocate(false)}
        onSuccess={(allocationId) => {
          setShowAllocate(false);
          showToast(`Asset allocated! ID: ${allocationId}`);
          void loadAllocations();
        }}
      />

      {/* Return Asset Modal — captures notes + condition */}
      <ReturnAssetModal
        open={!!returnTarget}
        asset={returnTarget}
        submitting={!!returnTarget && !!actionLoading[returnTarget.id]}
        onClose={() => setReturnTarget(null)}
        onConfirm={submitReturn}
      />

      {/* Rejecting a transfer — ask first */}
      <ConfirmDialog
        open={!!rejectTarget}
        title="Reject this transfer?"
        message={
          rejectTarget
            ? `${rejectTarget.assetName} will stay with its current holder and the request is declined.`
            : ""
        }
        confirmLabel="Reject transfer"
        destructive
        busy={!!rejectTarget && !!actionLoading[rejectTarget.id]}
        onCancel={() => setRejectTarget(null)}
        onConfirm={() => {
          if (!rejectTarget) return;
          const id = rejectTarget.id;
          setRejectTarget(null);
          void handleReject(id);
        }}
      />

      {/* Transfer Asset Modal — pick employee + reason */}
      <TransferAssetModal
        open={!!transferTarget}
        asset={transferTarget}
        submitting={!!transferTarget && !!actionLoading[transferTarget.id]}
        currentUserId={currentUserId}
        onClose={() => setTransferTarget(null)}
        onConfirm={submitTransfer}
      />
    </motion.div>
  );
}
