import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Package, Tag, Building2, Calendar, DollarSign,
  Check, Loader2, AlertCircle,
  CheckCircle2, Hash, MapPin, Camera, BookOpen,
  ChevronDown, Sparkles,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { apiGet, apiSend, unwrapList } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
type Condition = "NEW" | "GOOD" | "FAIR" | "POOR" | "DAMAGED";

interface Category {
  id: string;
  name: string;
}

interface RegisteredAsset {
  id: string;
  assetTag: string;
  name: string;
  category?: { id: string; name: string } | null;
  condition: string;
  location: string | null;
  status: string;
}

export interface RegisterAssetModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (asset: RegisteredAsset) => void;
}

// ─────────────────────────────────────────────────────────────
// CONDITION OPTIONS
// ─────────────────────────────────────────────────────────────
const CONDITIONS: { value: Condition; label: string; color: string; dot: string }[] = [
  { value: "NEW",     label: "New",     color: "text-success", dot: "bg-success" },
  { value: "GOOD",    label: "Good",    color: "text-info",    dot: "bg-info"    },
  { value: "FAIR",    label: "Fair",    color: "text-warning",   dot: "bg-warning"   },
  { value: "POOR",    label: "Poor",    color: "text-warning",  dot: "bg-warning"  },
  { value: "DAMAGED", label: "Damaged", color: "text-danger",     dot: "bg-danger"     },
];

// ─────────────────────────────────────────────────────────────
// API SERVICE (real backend via shared client)
// ─────────────────────────────────────────────────────────────
const registerService = {
  getCategories: async (): Promise<Category[]> => {
    const data = await apiGet<{ items: Category[] } | Category[]>("/org/categories");
    return unwrapList(data);
  },

  registerAsset: async (payload: {
    name: string;
    categoryId: string;
    serialNumber?: string;
    acquisitionDate?: string;
    acquisitionCost?: number;
    condition: Condition;
    location?: string;
    isBookable: boolean;
    photoUrl?: string;
  }): Promise<RegisteredAsset> => {
    return apiSend<RegisteredAsset>("/assets", "POST", payload);
  },
};

// ─────────────────────────────────────────────────────────────
// INPUT FIELD WRAPPER
// ─────────────────────────────────────────────────────────────
const inputCls = (hasError?: boolean) =>
  `w-full bg-canvas border rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none transition-all
  ${hasError ? "border-danger/60 focus:border-danger" : "border-line/80 focus:border-info/60 focus:bg-canvas"}`;

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────
export default function RegisterAssetModal({
  open, onClose, onSuccess,
}: RegisterAssetModalProps) {

  const [categories, setCategories] = useState<Category[]>([]);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<"form" | "success">("form");
  const [newAsset, setNewAsset] = useState<RegisteredAsset | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState("");
  const [catOpen, setCatOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Form state ──────────────────────────────────────────────
  const [form, setForm] = useState({
    name: "",
    categoryId: "",
    categoryName: "",
    serialNumber: "",
    acquisitionDate: "",
    acquisitionCost: "",
    condition: "GOOD" as Condition,
    location: "",
    isBookable: false,
    photoFileName: "",
  });

  // ── Load categories when modal opens ───────────────────────
  useEffect(() => {
    if (!open) return;
    setFetching(true);
    setLoadError("");
    registerService.getCategories()
      .then(setCategories)
      .catch((err: unknown) => setLoadError(errorMessage(err, "Failed to load categories")))
      .finally(() => setFetching(false));

    // Reset on open
    setForm({
      name: "", categoryId: "", categoryName: "", serialNumber: "",
      acquisitionDate: "", acquisitionCost: "", condition: "GOOD",
      location: "", isBookable: false, photoFileName: "",
    });
    setErrors({});
    setGlobalError("");
    setStep("form");
    setNewAsset(null);
    setCatOpen(false);
  }, [open]);

  const set = (field: string, value: unknown) => {
    setForm((p) => ({ ...p, [field]: value }));
    setErrors((p) => ({ ...p, [field]: "" }));
    setGlobalError("");
  };

  // ── Validation ──────────────────────────────────────────────
  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Asset name is required";
    if (!form.categoryId) e.categoryId = "Please select a category";
    if (form.acquisitionCost && isNaN(Number(form.acquisitionCost)))
      e.acquisitionCost = "Enter a valid number";
    return e;
  };

  // ── Submit ──────────────────────────────────────────────────
  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSubmitting(true);
    setGlobalError("");

    try {
      const payload = {
        name: form.name.trim(),
        categoryId: form.categoryId,
        serialNumber: form.serialNumber.trim() || undefined,
        acquisitionDate: form.acquisitionDate || undefined,
        acquisitionCost: form.acquisitionCost ? Number(form.acquisitionCost) : undefined,
        condition: form.condition,
        location: form.location.trim() || undefined,
        isBookable: form.isBookable,
        photoUrl: form.photoFileName || undefined,
      };

      // POST /assets — real backend call, assetTag auto-generated
      const created = await registerService.registerAsset(payload);
      setNewAsset(created);
      setStep("success");
    } catch (err) {
      setGlobalError(errorMessage(err, "Registration failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Register an asset"
      description="Add a new asset to the inventory."
      titleHidden
      closeOnBackdrop={step === "form"}
      panelClassName="w-full max-w-2xl"
    >
      {step === "success" && newAsset && (
        <div className="flex flex-col items-center justify-center px-8 py-14 text-center gap-5">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", damping: 14, stiffness: 200 }}
            className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center"
          >
            <CheckCircle2 size={40} className="text-success" />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <p className="text-xl font-bold text-ink mb-1">Asset Registered!</p>
            <p className="text-ink-muted text-sm">
              <span className="text-info font-semibold">{newAsset.name}</span> has been added to the inventory.
            </p>

            {/* Auto-generated tag */}
            <div className="mt-4 inline-flex items-center gap-2 bg-info/10 border border-info/25 rounded-xl px-5 py-3">
              <Sparkles size={15} className="text-info" />
              <div className="text-left">
                <p className="text-[11px] text-ink-subtle">Auto-generated Asset Tag</p>
                <p className="text-xl font-black text-info font-mono tracking-widest">{newAsset.assetTag}</p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-left">
              <div className="bg-canvas border border-line rounded-xl px-4 py-3">
                <p className="text-ink-subtle mb-0.5">Category</p>
                <p className="text-ink font-semibold">{newAsset.category?.name ?? form.categoryName}</p>
              </div>
              <div className="bg-canvas border border-line rounded-xl px-4 py-3">
                <p className="text-ink-subtle mb-0.5">Status</p>
                <p className="text-success font-semibold">Available</p>
              </div>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }}
            className="flex gap-3 w-full mt-2">
            <button
              onClick={() => {
                setStep("form");
                setNewAsset(null);
                setForm({
                  name: "", categoryId: "", categoryName: "", serialNumber: "",
                  acquisitionDate: "", acquisitionCost: "", condition: "GOOD",
                  location: "", isBookable: false, photoFileName: "",
                });
                setErrors({});
                setGlobalError("");
              }}
              className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all"
            >
              Register Another
            </button>
            <button
              onClick={() => { onSuccess(newAsset); onClose(); }}
              className="flex-1 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all"
            >
              Done
            </button>
          </motion.div>
        </div>
      )}

      {/* ══ FORM ══ */}
      {step === "form" && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-line flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-info/15 flex items-center justify-center">
                <Package size={20} className="text-info" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-ink">Register New Asset</h2>
                <p className="text-[11px] text-ink-subtle">Add a new physical asset to the inventory</p>
              </div>
            </div>
            <button aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-3/50 transition-colors">
              <X size={16} className="text-ink-muted" />
            </button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

            {/* Global error */}
            {globalError && (
              <div role="alert" className="flex items-center gap-2.5 bg-danger/10 border border-danger/30 rounded-xl px-4 py-3 text-sm text-danger">
                <AlertCircle size={15} className="flex-shrink-0" /> {globalError}
              </div>
            )}

            {/* ── ROW 1: Asset Name + Category ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Asset Name" required error={errors.name}>
                <div className="relative">
                  <Package size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    type="text"
                    placeholder="e.g. Dell Laptop XPS 15"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    className={`${inputCls(!!errors.name)} pl-10`}
                  />
                </div>
              </Field>

              {/* Category */}
              <Field label="Category" required error={errors.categoryId}>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setCatOpen((o) => !o)}
                    className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border text-left transition-all text-sm bg-canvas
                      ${errors.categoryId ? "border-danger/60" : catOpen ? "border-info/60" : "border-line/80 hover:border-line-strong"}`}
                  >
                    <Building2 size={15} className="text-ink-subtle flex-shrink-0" />
                    <span className={form.categoryId ? "text-ink flex-1" : "text-ink-faint flex-1"}>
                      {form.categoryName || "Select category…"}
                    </span>
                    {fetching
                      ? <Loader2 size={13} className="animate-spin text-ink-subtle" />
                      : <ChevronDown size={13} className={`text-ink-subtle transition-transform ${catOpen ? "rotate-180" : ""}`} />}
                  </button>

                  <AnimatePresence>
                    {catOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                        className="absolute z-50 top-full mt-1.5 w-full bg-surface border border-line rounded-xl shadow-2xl overflow-hidden"
                      >
                        <div className="max-h-44 overflow-y-auto divide-y divide-line/50">
                          {loadError ? (
                            <div className="py-6 px-4 text-center text-xs text-danger">
                              {loadError} — try again later
                            </div>
                          ) : categories.length === 0 ? (
                            <div className="py-6 text-center text-xs text-ink-subtle">No categories found</div>
                          ) : null}
                          {categories.map((cat) => (
                            <button key={cat.id} type="button"
                              onClick={() => { set("categoryId", cat.id); set("categoryName", cat.name); setCatOpen(false); }}
                              className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-3/40
                                ${form.categoryId === cat.id ? "text-info bg-info/10" : "text-ink-soft"}`}
                            >
                              <Building2 size={13} className="text-ink-subtle" />
                              <span className="text-sm">{cat.name}</span>
                              {form.categoryId === cat.id && <Check size={13} className="ml-auto text-info" />}
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </Field>
            </div>

            {/* ── ROW 2: Serial Number + Location ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Serial Number">
                <div className="relative">
                  <Hash size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    type="text"
                    placeholder="e.g. DL-2024-001"
                    value={form.serialNumber}
                    onChange={(e) => set("serialNumber", e.target.value)}
                    className={`${inputCls()} pl-10`}
                  />
                </div>
              </Field>

              <Field label="Location">
                <div className="relative">
                  <MapPin size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    type="text"
                    placeholder="e.g. IT Storage, Floor 2"
                    value={form.location}
                    onChange={(e) => set("location", e.target.value)}
                    className={`${inputCls()} pl-10`}
                  />
                </div>
              </Field>
            </div>

            {/* ── ROW 3: Acquisition Date + Cost ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Acquisition Date">
                <div className="relative">
                  <Calendar size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    type="date"
                    value={form.acquisitionDate}
                    onChange={(e) => set("acquisitionDate", e.target.value)}
                    className={`${inputCls()} pl-10 [color-scheme:dark]`}
                  />
                </div>
              </Field>

              <Field label="Acquisition Cost (₹)" error={errors.acquisitionCost}>
                <div className="relative">
                  <DollarSign size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    type="number"
                    placeholder="e.g. 85000"
                    min="0"
                    value={form.acquisitionCost}
                    onChange={(e) => set("acquisitionCost", e.target.value)}
                    className={`${inputCls(!!errors.acquisitionCost)} pl-10`}
                  />
                </div>
                <p className="text-[10px] text-ink-faint mt-1">For records only — not linked to accounting</p>
              </Field>
            </div>

            {/* ── Condition ── */}
            <Field label="Condition at Registration">
              <div className="flex flex-wrap gap-2">
                {CONDITIONS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => set("condition", c.value)}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-xs font-semibold transition-all
                      ${form.condition === c.value
                        ? `bg-surface-3/60 border-line-strong ${c.color}`
                        : "border-line text-ink-faint hover:border-line-strong hover:text-ink-soft"}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                    {c.label}
                  </button>
                ))}
              </div>
            </Field>

            {/* ── Bookable toggle ── */}
            <div className="flex items-center justify-between bg-canvas border border-line/80 rounded-xl px-4 py-3.5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-violet/15 flex items-center justify-center">
                  <BookOpen size={14} className="text-violet" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink">Shared / Bookable Resource</p>
                  <p className="text-[11px] text-ink-subtle">Employees can book this via Resource Booking</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => set("isBookable", !form.isBookable)}
                className={`relative w-11 h-6 rounded-full transition-all duration-300 focus:outline-none
                  ${form.isBookable ? "bg-violet" : "bg-line-strong"}`}
              >
                <motion.span
                  animate={{ x: form.isBookable ? 20 : 2 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  className="absolute top-1 left-0 w-4 h-4 bg-white rounded-full shadow-md"
                />
              </button>
            </div>

            {/* ── Photo upload ── */}
            <Field label="Attach Photo / Document (optional)">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border border-dashed border-line hover:border-line-strong transition-colors text-sm text-ink-subtle hover:text-ink-soft"
              >
                <Camera size={16} />
                {form.photoFileName
                  ? <span className="text-success">✓ {form.photoFileName}</span>
                  : "Click to attach a photo or document"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.pdf"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) set("photoFileName", e.target.files[0].name);
                }}
              />
            </Field>

            {/* ── Info notice ── */}
            <div className="flex items-start gap-2.5 bg-info/8 border border-info/20 rounded-xl px-4 py-3">
              <Tag size={13} className="text-info flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-info/80 leading-relaxed">
                <span className="font-semibold text-info">Asset Tag</span> will be auto-generated (e.g. AF-0145) by the system after registration.
                The asset will be set to <span className="text-success font-semibold">Available</span> status and ready for allocation.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-line flex gap-3 flex-shrink-0">
            <button
              aria-label="Close"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-line text-ink-muted text-sm hover:border-line-strong hover:text-ink transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex-1 py-2.5 rounded-xl bg-info hover:bg-info text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-blue-600/20"
            >
              {submitting
                ? <><Loader2 size={14} className="animate-spin" /> Registering…</>
                : <><Check size={14} /> Register Asset</>}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}