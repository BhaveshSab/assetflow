import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Package,
  User,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Tag,
  Building2,
  Clock,
  FileText,
  Shield,
  ArrowRight,
  Check,
  Info,
  Boxes,
  RefreshCw,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// SERVICE LAYER (real backend)
// ─────────────────────────────────────────────────────────────
import { Dialog } from "@/components/ui/dialog";
import { SearchDropdown } from "@/components/ui/search-dropdown";
import { apiGet, apiSend, unwrapList } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/**
 * The raw answers of the API, before they are shaped for the screen.
 * Writing them down means a change in the API is a compile error, not a
 * blank field.
 */
interface RawAsset {
  id: string;
  assetTag?: string;
  name?: string;
  category?: { name?: string } | null;
  condition?: string;
  location?: string;
  serialNumber?: string;
}

interface RawEmployee {
  id: string;
  name?: string;
  email?: string;
  department?: { name?: string } | null;
  role?: string;
}

const allocationService = {
  // GET /api/assets?status=AVAILABLE
  getAvailableAssets: async (): Promise<Asset[]> => {
    const data = await apiGet<{ items: RawAsset[] }>("/assets?status=AVAILABLE");
    return unwrapList<RawAsset>(data).map((a) => ({
      id: a.id,
      assetTag: a.assetTag ?? "—",
      name: a.name ?? "Unnamed asset",
      category: a.category?.name ?? "—",
      status: "Available",
      condition: normalizeCondition(a.condition),
      location: a.location ?? "—",
      serialNumber: a.serialNumber ?? "—",
    }));
  },

  // GET /api/org/employees?status=ACTIVE
  getEmployees: async (): Promise<Employee[]> => {
    const data = await apiGet<{ items: RawEmployee[] }>("/org/employees?status=ACTIVE");
    return unwrapList<RawEmployee>(data).map((e) => ({
      id: e.id,
      name: e.name ?? "Unnamed employee",
      email: e.email ?? "—",
      department: e.department?.name ?? "—",
      role: e.role ?? "Employee",
      avatar: (e.name ?? "??")
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2),
    }));
  },

  // POST /api/allocations  { assetId, holderUserId, expectedReturnDate }
  allocateAsset: async (payload: AllocationPayload): Promise<{ success: boolean; allocationId?: string; error?: string }> => {
    try {
      const res = await apiSend<{ id: string }>("/allocations", "POST", {
        assetId: payload.assetId,
        holderUserId: payload.employeeId,
        expectedReturnDate: payload.expectedReturnDate ?? undefined,
      });
      return { success: true, allocationId: res.id };
    } catch (err) {
      return { success: false, allocationId: undefined, error: errorMessage(err, "The allocation could not be created.") };
    }
  },
};

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
export type Condition = "New" | "Excellent" | "Good" | "Fair" | "Poor";

export interface Asset {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  status: "Available" | "Allocated" | "Under Maintenance" | "Reserved";
  condition: Condition;
  location: string;
  serialNumber?: string;
}

export interface Employee {
  id: string;
  name: string;
  email: string;
  department: string;
  role: string;
  avatar: string;
}

interface AllocationPayload {
  assetId: string;
  assetTag: string;
  employeeId: string;
  issueDate: string;
  expectedReturnDate: string | null;
  conditionAtIssue: Condition;
  remarks: string;
  allocatedBy: string;
}

interface AllocateAssetModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (allocationId: string) => void;
  currentUserId?: string;
  preSelectedAsset?: Asset | null;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split("T")[0];

const conditionConfig: Record<Condition, { color: string; dot: string }> = {
  New:       { color: "text-success", dot: "bg-success" },
  Excellent: { color: "text-info",    dot: "bg-info"    },
  Good:      { color: "text-cyan-400",    dot: "bg-cyan-400"    },
  Fair:      { color: "text-warning",   dot: "bg-warning"   },
  Poor:      { color: "text-danger",     dot: "bg-danger"     },
};

/** Backend enum (NEW/GOOD/FAIR/POOR/DAMAGED) → display Condition label. */
const normalizeCondition = (value: string | null | undefined): Condition =>
  ({
    NEW: "New",
    EXCELLENT: "Excellent",
    GOOD: "Good",
    FAIR: "Fair",
    POOR: "Poor",
    DAMAGED: "Poor",
  } as Record<string, Condition>)[(value ?? "").toUpperCase()] ?? "Good";

const avatarColors = [
  "bg-info","bg-violet","bg-success",
  "bg-warning","bg-danger","bg-cyan-600","bg-info",
];
const getAvatarColor = (name: string) =>
  avatarColors[name.charCodeAt(0) % avatarColors.length];

// ─────────────────────────────────────────────────────────────
// SEARCHABLE DROPDOWN COMPONENT
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// ASSET SUMMARY CARD
// ─────────────────────────────────────────────────────────────
const AssetSummaryCard = ({ asset }: { asset: Asset }) => {
  // Defensive fallback — never let an unknown condition crash the modal.
  const cond = conditionConfig[asset.condition] ?? conditionConfig.Good;
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="bg-info/8 border border-info/25 rounded-xl p-4 overflow-hidden"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-info/15 flex items-center justify-center flex-shrink-0">
          <Package size={18} className="text-info" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-ink">{asset.name}</p>
            <span className="text-[10px] bg-success/20 text-success border border-success/30 px-2 py-0.5 rounded-full font-bold">
              AVAILABLE
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
            <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
              <Tag size={10} className="text-ink-faint" />
              {asset.assetTag}
            </p>
            <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
              <Boxes size={10} className="text-ink-faint" />
              {asset.category}
            </p>
            <p className="text-[11px] flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${cond.dot}`} />
              <span className={cond.color}>{asset.condition}</span>
            </p>
            <p className="text-[11px] text-ink-muted flex items-center gap-1.5 truncate">
              <Building2 size={10} className="text-ink-faint flex-shrink-0" />
              <span className="truncate">{asset.location}</span>
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

// ─────────────────────────────────────────────────────────────
// MAIN MODAL COMPONENT
// ─────────────────────────────────────────────────────────────
const AllocateAssetModal = ({
  open,
  onClose,
  onSuccess,
  currentUserId = "manager-001",
  preSelectedAsset = null,
}: AllocateAssetModalProps) => {

  // ── Data ──
  const [assets, setAssets] = useState<Asset[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState("");

  // ── Form State ──
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [issueDate, setIssueDate] = useState(today());
  const [returnDate, setReturnDate] = useState("");
  const [noReturnDate, setNoReturnDate] = useState(false);
  const [condition, setCondition] = useState<Condition>("Good");
  const [remarks, setRemarks] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<"form" | "confirm" | "success">("form");
  const [allocationId, setAllocationId] = useState("");

  // ── Fetch data when modal opens ──
  useEffect(() => {
    if (!open) return;
    setFetching(true);
    setLoadError("");
    Promise.all([
      allocationService.getAvailableAssets(),
      allocationService.getEmployees(),
    ])
      .then(([a, e]) => {
        setAssets(a);
        setEmployees(e);
      })
      .catch(() =>
        setLoadError(
          "Couldn't load assets & employees. Check that the backend is running.",
        ),
      )
      .finally(() => setFetching(false));

    if (preSelectedAsset) setSelectedAsset(preSelectedAsset);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset on close ──
  const handleClose = () => {
    setSelectedAsset(null);
    setSelectedEmployee(null);
    setIssueDate(today());
    setReturnDate("");
    setNoReturnDate(false);
    setCondition("Good");
    setRemarks("");
    setErrors({});
    setStep("form");
    setAllocationId("");
    onClose();
  };

  // ── Validation ──
  const validate = () => {
    const e: Record<string, string> = {};
    if (!selectedAsset) e.asset = "Please select an asset to allocate";
    if (!selectedEmployee) e.employee = "Please select an employee";
    if (!issueDate) e.issueDate = "Issue date is required";
    if (!noReturnDate && returnDate && returnDate < issueDate)
      e.returnDate = "Return date cannot be before issue date";
    return e;
  };

  const handleSubmit = () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    setStep("confirm");
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const payload: AllocationPayload = {
        assetId: selectedAsset!.id,
        assetTag: selectedAsset!.assetTag,
        employeeId: selectedEmployee!.id,
        issueDate,
        expectedReturnDate: noReturnDate ? null : returnDate || null,
        conditionAtIssue: condition,
        remarks: remarks.trim(),
        allocatedBy: currentUserId,
      };

      const result = await allocationService.allocateAsset(payload);

      if (result.success) {
        setAllocationId(result.allocationId ?? "");
        setStep("success");
      } else {
        setErrors({
          submit: result.error ?? "Allocation failed. Please try again.",
        });
        setStep("form");
      }
    } catch {
      setErrors({ submit: "Network error. Please try again." });
      setStep("form");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Days until return ──
  const daysUntilReturn = returnDate
    ? Math.ceil((new Date(returnDate).getTime() - new Date().getTime()) / 86400000)
    : null;

  const CONDITIONS: Condition[] = ["New", "Excellent", "Good", "Fair", "Poor"];

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Allocate an asset"
      description="Give an asset to an employee and record the handover."
      titleHidden
      closeOnBackdrop={step === "form"}
      panelClassName="w-full max-w-2xl"
    >

      {/* ══ STEP: FORM ══ */}
      {step === "form" && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-line flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-info/15 flex items-center justify-center">
                <Package size={18} className="text-info" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-ink">Allocate Asset</h2>
                <p className="text-[11px] text-ink-subtle">Assign an available asset to an employee</p>
              </div>
            </div>
            <button aria-label="Close" onClick={handleClose} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
              <X size={16} className="text-ink-muted" />
            </button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
            {loadError && (
              <div role="alert" className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-xl px-4 py-2.5 text-sm text-danger">
                <AlertTriangle size={14} /> {loadError}
              </div>
            )}

            {fetching && (
              <div className="flex items-center justify-center py-8 gap-2 text-ink-subtle text-sm">
                <Loader2 size={18} className="animate-spin text-info" />
                Loading assets & employees…
              </div>
            )}

            {!fetching && (
              <>
                {/* ROW 1: Asset + Employee */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <SearchDropdown<Asset>
                    label="Select Asset"
                    placeholder="Search by name or tag…"
                    icon={Package}
                    items={assets}
                    selected={selectedAsset}
                    onSelect={(a) => {
                      setSelectedAsset(a);
                      setCondition(normalizeCondition(a.condition));
                      setErrors((p) => ({ ...p, asset: "" }));
                    }}
                    renderSelected={(a) => (
                      <span className="text-ink font-medium truncate">{a.name}
                        <span className="ml-2 text-ink-subtle font-normal text-xs">{a.assetTag}</span>
                      </span>
                    )}
                    renderItem={(a) => (
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-info/15 flex items-center justify-center flex-shrink-0">
                          <Package size={14} className="text-info" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink truncate">{a.name}</p>
                          <p className="text-[11px] text-ink-subtle">{a.assetTag} · {a.category}</p>
                        </div>
                        <span className={`text-[10px] font-semibold ${conditionConfig[a.condition]?.color}`}>
                          {a.condition}
                        </span>
                      </div>
                    )}
                    filterFn={(a, q) =>
                      a.name.toLowerCase().includes(q.toLowerCase()) ||
                      a.assetTag.toLowerCase().includes(q.toLowerCase()) ||
                      a.category.toLowerCase().includes(q.toLowerCase())
                    }
                    error={errors.asset}
                    required
                  />

                  <SearchDropdown<Employee>
                    label="Assign To (Employee)"
                    placeholder="Search by name or dept…"
                    icon={User}
                    items={employees}
                    selected={selectedEmployee}
                    onSelect={(e) => {
                      setSelectedEmployee(e);
                      setErrors((p) => ({ ...p, employee: "" }));
                    }}
                    renderSelected={(e) => (
                      <span className="text-ink font-medium truncate">{e.name}
                        <span className="ml-2 text-ink-subtle font-normal text-xs">{e.department}</span>
                      </span>
                    )}
                    renderItem={(e) => (
                      <div className="flex items-center gap-2.5">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-ink flex-shrink-0 ${getAvatarColor(e.name)}`}>
                          {e.avatar}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink">{e.name}</p>
                          <p className="text-[11px] text-ink-subtle">{e.department} · {e.role}</p>
                        </div>
                      </div>
                    )}
                    filterFn={(e, q) =>
                      e.name.toLowerCase().includes(q.toLowerCase()) ||
                      e.department.toLowerCase().includes(q.toLowerCase()) ||
                      e.email.toLowerCase().includes(q.toLowerCase())
                    }
                    error={errors.employee}
                    required
                  />
                </div>

                {/* ASSET SUMMARY CARD */}
                <AnimatePresence>
                  {selectedAsset && <AssetSummaryCard asset={selectedAsset} />}
                </AnimatePresence>

                {/* ROW 2: Dates */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1.5">
                      Issue Date <span className="text-danger">*</span>
                    </label>
                    <div className="relative">
                      <Calendar size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                      <input
                        type="date"
                        value={issueDate}
                        onChange={(e) => {
                          setIssueDate(e.target.value);
                          setErrors((p) => ({ ...p, issueDate: "" }));
                        }}
                        className="w-full bg-canvas border border-line rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink outline-none focus:border-info/60 transition-colors [color-scheme:dark]"
                      />
                    </div>
                    {errors.issueDate && (
                      <p className="text-danger text-[11px] mt-1 flex items-center gap-1">
                        <AlertTriangle size={10} /> {errors.issueDate}
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-medium text-ink-muted">Expected Return Date</label>
                      <label className="flex items-center gap-1.5 text-[11px] text-ink-subtle cursor-pointer">
                        <input
                          type="checkbox"
                          checked={noReturnDate}
                          onChange={(e) => {
                            setNoReturnDate(e.target.checked);
                            if (e.target.checked) setReturnDate("");
                            setErrors((p) => ({ ...p, returnDate: "" }));
                          }}
                          className="accent-blue-500 w-3 h-3"
                        />
                        No fixed return date
                      </label>
                    </div>
                    <div className="relative">
                      <Clock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                      <input
                        type="date"
                        value={returnDate}
                        min={issueDate}
                        disabled={noReturnDate}
                        onChange={(e) => {
                          setReturnDate(e.target.value);
                          setErrors((p) => ({ ...p, returnDate: "" }));
                        }}
                        className="w-full bg-canvas border border-line rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink outline-none focus:border-info/60 transition-colors [color-scheme:dark] disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                    </div>
                    {daysUntilReturn !== null && !noReturnDate && returnDate && (
                      <p className={`text-[11px] mt-1 flex items-center gap-1
                        ${daysUntilReturn < 7 ? "text-warning" : "text-ink-subtle"}`}>
                        <Clock size={10} />
                        {daysUntilReturn > 0
                          ? `Due in ${daysUntilReturn} days`
                          : daysUntilReturn === 0
                          ? "Due today"
                          : "Return date is in the past"}
                      </p>
                    )}
                    {noReturnDate && (
                      <p className="text-[11px] mt-1 text-ink-faint flex items-center gap-1">
                        <Info size={10} /> Will be tracked as indefinite allocation
                      </p>
                    )}
                    {errors.returnDate && (
                      <p className="text-danger text-[11px] mt-1 flex items-center gap-1">
                        <AlertTriangle size={10} /> {errors.returnDate}
                      </p>
                    )}
                  </div>
                </div>

                {/* ROW 3: Condition */}
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-2">
                    Condition at Issue
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {CONDITIONS.map((c) => {
                      const cfg = conditionConfig[c];
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setCondition(c)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all
                            ${condition === c
                              ? `bg-surface-3/60 border-line-strong ${cfg.color}`
                              : "border-line text-ink-faint hover:border-line-strong hover:text-ink-soft"}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ROW 4: Remarks */}
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5">
                    Remarks / Notes
                  </label>
                  <div className="relative">
                    <FileText size={14} className="absolute left-3.5 top-3 text-ink-subtle" />
                    <textarea
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      placeholder="Any specific notes about this allocation (e.g., purpose, special instructions)…"
                      rows={3}
                      className="w-full bg-canvas border border-line rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-info/60 transition-colors resize-none"
                    />
                  </div>
                  <p className="text-[11px] text-ink-faint mt-1 text-right">{remarks.length}/500</p>
                </div>

                {/* OVERDUE LOGIC NOTE */}
                {!noReturnDate && (
                  <div className="flex items-start gap-2.5 bg-surface-3/40 border border-line/50 rounded-xl px-4 py-3">
                    <Info size={13} className="text-info flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-ink-muted leading-relaxed">
                      <span className="text-ink font-medium">Overdue tracking:</span> If the asset is not
                      returned by the Expected Return Date, it will automatically appear in the{" "}
                      <span className="text-danger font-medium">Overdue Returns</span> KPI on the dashboard.
                    </p>
                  </div>
                )}

                {/* Submit error */}
                {errors.submit && (
                  <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-xl px-4 py-2.5 text-sm text-danger">
                    <AlertTriangle size={14} /> {errors.submit}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-line flex items-center gap-3 flex-shrink-0">
            <button onClick={handleClose}
              className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!selectedAsset || !selectedEmployee || fetching}
              className="flex-1 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-600/20"
            >
              Review Allocation <ArrowRight size={14} />
            </button>
          </div>
        </>
      )}

      {/* ══ STEP: CONFIRM ══ */}
      {step === "confirm" && (
        <>
          <div className="flex items-center justify-between px-6 py-4 border-b border-line flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-warning/15 flex items-center justify-center">
                <Shield size={18} className="text-warning" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-ink">Confirm Allocation</h2>
                <p className="text-[11px] text-ink-subtle">Review the details before submitting</p>
              </div>
            </div>
            <button onClick={() => setStep("form")} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
              <X size={16} className="text-ink-muted" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
            {[
              { label: "Asset",     value: `${selectedAsset?.name} (${selectedAsset?.assetTag})`,            icon: Package  },
              { label: "Category",  value: selectedAsset?.category ?? "",                                    icon: Boxes    },
              { label: "Assign To", value: `${selectedEmployee?.name} — ${selectedEmployee?.department}`,    icon: User     },
              { label: "Issue Date", value: issueDate,                                                       icon: Calendar },
              { label: "Return By", value: noReturnDate ? "No fixed return date" : (returnDate || "Not set"), icon: Clock   },
              { label: "Condition", value: condition,                                                       icon: Tag      },
              { label: "Remarks",   value: remarks || "—",                                                  icon: FileText },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="flex items-start gap-3 py-2 border-b border-line/50 last:border-0">
                <Icon size={14} className="text-ink-subtle mt-0.5 flex-shrink-0" />
                <div className="flex-1 grid grid-cols-2 gap-2">
                  <span className="text-xs text-ink-subtle">{label}</span>
                  <span className="text-sm text-ink font-medium">{value}</span>
                </div>
              </div>
            ))}

            <div className="bg-warning/8 border border-warning/25 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <AlertTriangle size={14} className="text-warning flex-shrink-0" />
              <p className="text-xs text-warning">
                This will change the asset status to <span className="font-bold">Allocated</span> and it
                will no longer be available for others until returned.
              </p>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-line flex gap-3 flex-shrink-0">
            <button onClick={() => setStep("form")}
              className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all">
              Back & Edit
            </button>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              className="flex-1 py-2.5 rounded-xl bg-success hover:bg-success text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-60 shadow-lg shadow-emerald-600/20"
            >
              {submitting
                ? <><Loader2 size={14} className="animate-spin" /> Allocating…</>
                : <><Check size={14} /> Confirm Allocation</>}
            </button>
          </div>
        </>
      )}

      {/* ══ STEP: SUCCESS ══ */}
      {step === "success" && (
        <div className="flex flex-col items-center justify-center px-8 py-12 text-center gap-4">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring" as const, damping: 14, stiffness: 200 }}
            className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center"
          >
            <CheckCircle2 size={40} className="text-success" />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <p className="text-xl font-bold text-ink mb-1">Asset Allocated!</p>
            <p className="text-ink-muted text-sm">
              <span className="text-info font-semibold">{selectedAsset?.name}</span> has been
              successfully assigned to{" "}
              <span className="text-success font-semibold">{selectedEmployee?.name}</span>.
            </p>
            {allocationId && (
              <p className="text-ink-faint text-xs mt-2">
                Allocation ID: <span className="text-ink-muted font-mono">{allocationId}</span>
              </p>
            )}
            {!noReturnDate && returnDate && (
              <div className="mt-3 bg-canvas border border-line rounded-xl px-4 py-2.5 text-xs text-ink-muted">
                <Clock size={11} className="inline mr-1.5 text-warning" />
                Expected return by <span className="text-ink font-medium">{returnDate}</span>
                {daysUntilReturn !== null && ` (${daysUntilReturn} days)`}
              </div>
            )}
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.35 }}
            className="flex gap-3 w-full mt-2"
          >
            <button
              onClick={() => {
                setSelectedAsset(null);
                setSelectedEmployee(null);
                setReturnDate("");
                setNoReturnDate(false);
                setRemarks("");
                setCondition("Good");
                setStep("form");
              }}
              className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all flex items-center justify-center gap-1.5"
            >
              <RefreshCw size={13} /> Allocate Another
            </button>
            <button
              onClick={() => { onSuccess(allocationId); handleClose(); }}
              className="flex-1 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all"
            >
              Done
            </button>
          </motion.div>
        </div>
      )}
    </Dialog>
  );
};

export default AllocateAssetModal;
