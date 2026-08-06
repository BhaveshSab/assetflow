import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Search,
  Package,
  User,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
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
import { apiGet, apiSend, unwrapList } from "@/lib/api";

const allocationService = {
  // GET /api/assets?status=AVAILABLE
  getAvailableAssets: async (): Promise<Asset[]> => {
    const data = await apiGet<{ items: Array<Record<string, any>> }>("/assets?status=AVAILABLE");
    return unwrapList(data as never).map((a: any) => ({
      id: a.id,
      assetTag: a.assetTag,
      name: a.name,
      category: a.category?.name ?? "—",
      status: "Available",
      condition: normalizeCondition(a.condition),
      location: a.location ?? "—",
      serialNumber: a.serialNumber,
    }));
  },

  // GET /api/org/employees?status=ACTIVE
  getEmployees: async (): Promise<Employee[]> => {
    const data = await apiGet<{ items: Array<Record<string, any>> }>("/org/employees?status=ACTIVE");
    return unwrapList(data as never).map((e: any) => ({
      id: e.id,
      name: e.name,
      email: e.email,
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
    } catch (err: any) {
      return { success: false, allocationId: undefined, error: err?.message };
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
  New:       { color: "text-emerald-400", dot: "bg-emerald-400" },
  Excellent: { color: "text-blue-400",    dot: "bg-blue-400"    },
  Good:      { color: "text-cyan-400",    dot: "bg-cyan-400"    },
  Fair:      { color: "text-amber-400",   dot: "bg-amber-400"   },
  Poor:      { color: "text-red-400",     dot: "bg-red-400"     },
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
  "bg-blue-600","bg-purple-600","bg-emerald-600",
  "bg-amber-600","bg-rose-600","bg-cyan-600","bg-indigo-600",
];
const getAvatarColor = (name: string) =>
  avatarColors[name.charCodeAt(0) % avatarColors.length];

// ─────────────────────────────────────────────────────────────
// SEARCHABLE DROPDOWN COMPONENT
// ─────────────────────────────────────────────────────────────
function SearchDropdown<T>({
  label,
  placeholder,
  icon: Icon,
  items,
  selected,
  onSelect,
  renderItem,
  renderSelected,
  filterFn,
  error,
  required,
}: {
  label: string;
  placeholder: string;
  icon: React.ElementType;
  items: T[];
  selected: T | null;
  onSelect: (item: T) => void;
  renderItem: (item: T) => React.ReactNode;
  renderSelected: (item: T) => React.ReactNode;
  filterFn: (item: T, query: string) => boolean;
  error?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => query ? items.filter((i) => filterFn(i, query)) : items,
    [items, query, filterFn]
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <label className="block text-xs font-medium text-zinc-400 mb-1.5">
        {label} {required && <span className="text-red-400">*</span>}
      </label>

      {/* Trigger */}
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQuery(""); }}
        className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl border text-left transition-all
          ${error
            ? "border-red-500/60 bg-red-950/20"
            : open
            ? "border-blue-500/60 bg-[#0f111a]"
            : "border-zinc-700 bg-[#0f111a] hover:border-zinc-600"}`}
      >
        <Icon size={15} className="text-zinc-500 flex-shrink-0" />
        <div className="flex-1 min-w-0 text-sm">
          {selected ? renderSelected(selected) : (
            <span className="text-zinc-600">{placeholder}</span>
          )}
        </div>
        <ChevronDown
          size={14}
          className={`text-zinc-500 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute z-50 top-full mt-1.5 w-full bg-[#1a1d2e] border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
          >
            <div className="p-2 border-b border-zinc-800">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  className="w-full bg-[#0f111a] border border-zinc-700 rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/50"
                />
              </div>
            </div>

            <div className="max-h-52 overflow-y-auto divide-y divide-zinc-800/50">
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-zinc-500">No results found</div>
              ) : (
                filtered.map((item, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => { onSelect(item); setOpen(false); setQuery(""); }}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-zinc-700/40 transition-colors text-sm"
                  >
                    {renderItem(item)}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <p className="text-red-400 text-[11px] mt-1 flex items-center gap-1">
          <AlertTriangle size={10} /> {error}
        </p>
      )}
    </div>
  );
}

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
      className="bg-blue-950/30 border border-blue-500/25 rounded-xl p-4 overflow-hidden"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center flex-shrink-0">
          <Package size={18} className="text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-white">{asset.name}</p>
            <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
              AVAILABLE
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
            <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
              <Tag size={10} className="text-zinc-600" />
              {asset.assetTag}
            </p>
            <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
              <Boxes size={10} className="text-zinc-600" />
              {asset.category}
            </p>
            <p className="text-[11px] flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${cond.dot}`} />
              <span className={cond.color}>{asset.condition}</span>
            </p>
            <p className="text-[11px] text-zinc-400 flex items-center gap-1.5 truncate">
              <Building2 size={10} className="text-zinc-600 flex-shrink-0" />
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

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
          onClick={step === "form" ? handleClose : undefined}
        >
          <motion.div
            initial={{ scale: 0.93, opacity: 0, y: 24 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.93, opacity: 0, y: 24 }}
            transition={{ type: "spring" as const, damping: 26, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#1a1d2e] border border-zinc-700/80 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden max-h-[95vh] flex flex-col"
          >

            {/* ══ STEP: FORM ══ */}
            {step === "form" && (
              <>
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-blue-500/15 flex items-center justify-center">
                      <Package size={18} className="text-blue-400" />
                    </div>
                    <div>
                      <h2 className="text-sm font-bold text-white">Allocate Asset</h2>
                      <p className="text-[11px] text-zinc-500">Assign an available asset to an employee</p>
                    </div>
                  </div>
                  <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-zinc-700/50 transition-colors">
                    <X size={16} className="text-zinc-400" />
                  </button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
                  {loadError && (
                    <div className="flex items-center gap-2 bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-2.5 text-sm text-red-400">
                      <AlertTriangle size={14} /> {loadError}
                    </div>
                  )}

                  {fetching && (
                    <div className="flex items-center justify-center py-8 gap-2 text-zinc-500 text-sm">
                      <Loader2 size={18} className="animate-spin text-blue-400" />
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
                            <span className="text-white font-medium truncate">{a.name}
                              <span className="ml-2 text-zinc-500 font-normal text-xs">{a.assetTag}</span>
                            </span>
                          )}
                          renderItem={(a) => (
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center flex-shrink-0">
                                <Package size={14} className="text-blue-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white truncate">{a.name}</p>
                                <p className="text-[11px] text-zinc-500">{a.assetTag} · {a.category}</p>
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
                            <span className="text-white font-medium truncate">{e.name}
                              <span className="ml-2 text-zinc-500 font-normal text-xs">{e.department}</span>
                            </span>
                          )}
                          renderItem={(e) => (
                            <div className="flex items-center gap-2.5">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0 ${getAvatarColor(e.name)}`}>
                                {e.avatar}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white">{e.name}</p>
                                <p className="text-[11px] text-zinc-500">{e.department} · {e.role}</p>
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
                          <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                            Issue Date <span className="text-red-400">*</span>
                          </label>
                          <div className="relative">
                            <Calendar size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                            <input
                              type="date"
                              value={issueDate}
                              onChange={(e) => {
                                setIssueDate(e.target.value);
                                setErrors((p) => ({ ...p, issueDate: "" }));
                              }}
                              className="w-full bg-[#0f111a] border border-zinc-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white outline-none focus:border-blue-500/60 transition-colors [color-scheme:dark]"
                            />
                          </div>
                          {errors.issueDate && (
                            <p className="text-red-400 text-[11px] mt-1 flex items-center gap-1">
                              <AlertTriangle size={10} /> {errors.issueDate}
                            </p>
                          )}
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-zinc-400">Expected Return Date</label>
                            <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer">
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
                            <Clock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                            <input
                              type="date"
                              value={returnDate}
                              min={issueDate}
                              disabled={noReturnDate}
                              onChange={(e) => {
                                setReturnDate(e.target.value);
                                setErrors((p) => ({ ...p, returnDate: "" }));
                              }}
                              className="w-full bg-[#0f111a] border border-zinc-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white outline-none focus:border-blue-500/60 transition-colors [color-scheme:dark] disabled:opacity-40 disabled:cursor-not-allowed"
                            />
                          </div>
                          {daysUntilReturn !== null && !noReturnDate && returnDate && (
                            <p className={`text-[11px] mt-1 flex items-center gap-1
                              ${daysUntilReturn < 7 ? "text-amber-400" : "text-zinc-500"}`}>
                              <Clock size={10} />
                              {daysUntilReturn > 0
                                ? `Due in ${daysUntilReturn} days`
                                : daysUntilReturn === 0
                                ? "Due today"
                                : "Return date is in the past"}
                            </p>
                          )}
                          {noReturnDate && (
                            <p className="text-[11px] mt-1 text-zinc-600 flex items-center gap-1">
                              <Info size={10} /> Will be tracked as indefinite allocation
                            </p>
                          )}
                          {errors.returnDate && (
                            <p className="text-red-400 text-[11px] mt-1 flex items-center gap-1">
                              <AlertTriangle size={10} /> {errors.returnDate}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* ROW 3: Condition */}
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-2">
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
                                    ? `bg-zinc-700/60 border-zinc-500 ${cfg.color}`
                                    : "border-zinc-800 text-zinc-600 hover:border-zinc-600 hover:text-zinc-300"}`}
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
                        <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                          Remarks / Notes
                        </label>
                        <div className="relative">
                          <FileText size={14} className="absolute left-3.5 top-3 text-zinc-500" />
                          <textarea
                            value={remarks}
                            onChange={(e) => setRemarks(e.target.value)}
                            placeholder="Any specific notes about this allocation (e.g., purpose, special instructions)…"
                            rows={3}
                            className="w-full bg-[#0f111a] border border-zinc-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/60 transition-colors resize-none"
                          />
                        </div>
                        <p className="text-[11px] text-zinc-600 mt-1 text-right">{remarks.length}/500</p>
                      </div>

                      {/* OVERDUE LOGIC NOTE */}
                      {!noReturnDate && (
                        <div className="flex items-start gap-2.5 bg-zinc-800/40 border border-zinc-700/50 rounded-xl px-4 py-3">
                          <Info size={13} className="text-blue-400 flex-shrink-0 mt-0.5" />
                          <p className="text-[11px] text-zinc-400 leading-relaxed">
                            <span className="text-white font-medium">Overdue tracking:</span> If the asset is not
                            returned by the Expected Return Date, it will automatically appear in the{" "}
                            <span className="text-red-400 font-medium">Overdue Returns</span> KPI on the dashboard.
                          </p>
                        </div>
                      )}

                      {/* Submit error */}
                      {errors.submit && (
                        <div className="flex items-center gap-2 bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-2.5 text-sm text-red-400">
                          <AlertTriangle size={14} /> {errors.submit}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-zinc-800 flex items-center gap-3 flex-shrink-0">
                  <button onClick={handleClose}
                    className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all">
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={!selectedAsset || !selectedEmployee || fetching}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-600/20"
                  >
                    Review Allocation <ArrowRight size={14} />
                  </button>
                </div>
              </>
            )}

            {/* ══ STEP: CONFIRM ══ */}
            {step === "confirm" && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/15 flex items-center justify-center">
                      <Shield size={18} className="text-amber-400" />
                    </div>
                    <div>
                      <h2 className="text-sm font-bold text-white">Confirm Allocation</h2>
                      <p className="text-[11px] text-zinc-500">Review the details before submitting</p>
                    </div>
                  </div>
                  <button onClick={() => setStep("form")} className="p-1.5 rounded-lg hover:bg-zinc-700/50 transition-colors">
                    <X size={16} className="text-zinc-400" />
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
                    <div key={label} className="flex items-start gap-3 py-2 border-b border-zinc-800/50 last:border-0">
                      <Icon size={14} className="text-zinc-500 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 grid grid-cols-2 gap-2">
                        <span className="text-xs text-zinc-500">{label}</span>
                        <span className="text-sm text-white font-medium">{value}</span>
                      </div>
                    </div>
                  ))}

                  <div className="bg-amber-950/30 border border-amber-500/25 rounded-xl px-4 py-3 flex items-center gap-2.5">
                    <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
                    <p className="text-xs text-amber-300">
                      This will change the asset status to <span className="font-bold">Allocated</span> and it
                      will no longer be available for others until returned.
                    </p>
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-zinc-800 flex gap-3 flex-shrink-0">
                  <button onClick={() => setStep("form")}
                    className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all">
                    Back & Edit
                  </button>
                  <button
                    onClick={handleConfirm}
                    disabled={submitting}
                    className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-60 shadow-lg shadow-emerald-600/20"
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
                  className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center"
                >
                  <CheckCircle2 size={40} className="text-emerald-400" />
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                >
                  <p className="text-xl font-bold text-white mb-1">Asset Allocated!</p>
                  <p className="text-zinc-400 text-sm">
                    <span className="text-blue-400 font-semibold">{selectedAsset?.name}</span> has been
                    successfully assigned to{" "}
                    <span className="text-emerald-400 font-semibold">{selectedEmployee?.name}</span>.
                  </p>
                  {allocationId && (
                    <p className="text-zinc-600 text-xs mt-2">
                      Allocation ID: <span className="text-zinc-400 font-mono">{allocationId}</span>
                    </p>
                  )}
                  {!noReturnDate && returnDate && (
                    <div className="mt-3 bg-[#0f111a] border border-zinc-700 rounded-xl px-4 py-2.5 text-xs text-zinc-400">
                      <Clock size={11} className="inline mr-1.5 text-amber-400" />
                      Expected return by <span className="text-white font-medium">{returnDate}</span>
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
                    className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all flex items-center justify-center gap-1.5"
                  >
                    <RefreshCw size={13} /> Allocate Another
                  </button>
                  <button
                    onClick={() => { onSuccess(allocationId); handleClose(); }}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all"
                  >
                    Done
                  </button>
                </motion.div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default AllocateAssetModal;
