import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Package, Tag, Building2, Calendar, DollarSign,
  Check, Loader2, AlertTriangle, AlertCircle,
  CheckCircle2, Hash, MapPin, Camera, BookOpen,
  ChevronDown, Sparkles,
} from "lucide-react";
import { apiGet, apiSend, unwrapList } from "@/lib/api";

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
  { value: "NEW",     label: "New",     color: "text-emerald-400", dot: "bg-emerald-400" },
  { value: "GOOD",    label: "Good",    color: "text-blue-400",    dot: "bg-blue-400"    },
  { value: "FAIR",    label: "Fair",    color: "text-amber-400",   dot: "bg-amber-400"   },
  { value: "POOR",    label: "Poor",    color: "text-orange-400",  dot: "bg-orange-400"  },
  { value: "DAMAGED", label: "Damaged", color: "text-red-400",     dot: "bg-red-400"     },
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
const Field = ({
  label, required, error, children,
}: {
  label: string; required?: boolean; error?: string; children: React.ReactNode;
}) => (
  <div>
    <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wide">
      {label} {required && <span className="text-red-400 normal-case">*</span>}
    </label>
    {children}
    {error && (
      <p className="text-red-400 text-[11px] mt-1.5 flex items-center gap-1">
        <AlertTriangle size={10} /> {error}
      </p>
    )}
  </div>
);

const inputCls = (hasError?: boolean) =>
  `w-full bg-[#0f111a] border rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none transition-all
  ${hasError ? "border-red-500/60 focus:border-red-500" : "border-zinc-700/80 focus:border-blue-500/60 focus:bg-[#0a0c14]"}`;

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
      .catch((err: any) => setLoadError(err?.message ?? "Failed to load categories"))
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
    } catch (err: any) {
      setGlobalError(err?.message ?? "Registration failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
          onClick={step === "form" ? onClose : undefined}
        >
          <motion.div
            initial={{ scale: 0.93, opacity: 0, y: 24 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.93, opacity: 0, y: 24 }}
            transition={{ type: "spring", damping: 26, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#1a1d2e] border border-zinc-700/80 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden max-h-[95vh] flex flex-col"
          >

            {/* ══ SUCCESS SCREEN ══ */}
            {step === "success" && newAsset && (
              <div className="flex flex-col items-center justify-center px-8 py-14 text-center gap-5">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", damping: 14, stiffness: 200 }}
                  className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center"
                >
                  <CheckCircle2 size={40} className="text-emerald-400" />
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                  <p className="text-xl font-bold text-white mb-1">Asset Registered!</p>
                  <p className="text-zinc-400 text-sm">
                    <span className="text-blue-400 font-semibold">{newAsset.name}</span> has been added to the inventory.
                  </p>

                  {/* Auto-generated tag */}
                  <div className="mt-4 inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/25 rounded-xl px-5 py-3">
                    <Sparkles size={15} className="text-blue-400" />
                    <div className="text-left">
                      <p className="text-[11px] text-zinc-500">Auto-generated Asset Tag</p>
                      <p className="text-xl font-black text-blue-400 font-mono tracking-widest">{newAsset.assetTag}</p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-left">
                    <div className="bg-[#0f111a] border border-zinc-800 rounded-xl px-4 py-3">
                      <p className="text-zinc-500 mb-0.5">Category</p>
                      <p className="text-white font-semibold">{newAsset.category?.name ?? form.categoryName}</p>
                    </div>
                    <div className="bg-[#0f111a] border border-zinc-800 rounded-xl px-4 py-3">
                      <p className="text-zinc-500 mb-0.5">Status</p>
                      <p className="text-emerald-400 font-semibold">Available</p>
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
                    className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all"
                  >
                    Register Another
                  </button>
                  <button
                    onClick={() => { onSuccess(newAsset); onClose(); }}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all"
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
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center">
                      <Package size={20} className="text-blue-400" />
                    </div>
                    <div>
                      <h2 className="text-sm font-bold text-white">Register New Asset</h2>
                      <p className="text-[11px] text-zinc-500">Add a new physical asset to the inventory</p>
                    </div>
                  </div>
                  <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-700/50 transition-colors">
                    <X size={16} className="text-zinc-400" />
                  </button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

                  {/* Global error */}
                  {globalError && (
                    <div className="flex items-center gap-2.5 bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400">
                      <AlertCircle size={15} className="flex-shrink-0" /> {globalError}
                    </div>
                  )}

                  {/* ── ROW 1: Asset Name + Category ── */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Asset Name" required error={errors.name}>
                      <div className="relative">
                        <Package size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
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
                          className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border text-left transition-all text-sm bg-[#0f111a]
                            ${errors.categoryId ? "border-red-500/60" : catOpen ? "border-blue-500/60" : "border-zinc-700/80 hover:border-zinc-600"}`}
                        >
                          <Building2 size={15} className="text-zinc-500 flex-shrink-0" />
                          <span className={form.categoryId ? "text-white flex-1" : "text-zinc-600 flex-1"}>
                            {form.categoryName || "Select category…"}
                          </span>
                          {fetching
                            ? <Loader2 size={13} className="animate-spin text-zinc-500" />
                            : <ChevronDown size={13} className={`text-zinc-500 transition-transform ${catOpen ? "rotate-180" : ""}`} />}
                        </button>

                        <AnimatePresence>
                          {catOpen && (
                            <motion.div
                              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                              className="absolute z-50 top-full mt-1.5 w-full bg-[#1a1d2e] border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
                            >
                              <div className="max-h-44 overflow-y-auto divide-y divide-zinc-800/50">
                                {loadError ? (
                                  <div className="py-6 px-4 text-center text-xs text-red-400">
                                    {loadError} — try again later
                                  </div>
                                ) : categories.length === 0 ? (
                                  <div className="py-6 text-center text-xs text-zinc-500">No categories found</div>
                                ) : null}
                                {categories.map((cat) => (
                                  <button key={cat.id} type="button"
                                    onClick={() => { set("categoryId", cat.id); set("categoryName", cat.name); setCatOpen(false); }}
                                    className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-zinc-700/40
                                      ${form.categoryId === cat.id ? "text-blue-400 bg-blue-500/10" : "text-zinc-300"}`}
                                  >
                                    <Building2 size={13} className="text-zinc-500" />
                                    <span className="text-sm">{cat.name}</span>
                                    {form.categoryId === cat.id && <Check size={13} className="ml-auto text-blue-400" />}
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
                        <Hash size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
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
                        <MapPin size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
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
                        <Calendar size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
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
                        <DollarSign size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                          type="number"
                          placeholder="e.g. 85000"
                          min="0"
                          value={form.acquisitionCost}
                          onChange={(e) => set("acquisitionCost", e.target.value)}
                          className={`${inputCls(!!errors.acquisitionCost)} pl-10`}
                        />
                      </div>
                      <p className="text-[10px] text-zinc-600 mt-1">For records only — not linked to accounting</p>
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
                              ? `bg-zinc-700/60 border-zinc-500 ${c.color}`
                              : "border-zinc-800 text-zinc-600 hover:border-zinc-600 hover:text-zinc-300"}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </Field>

                  {/* ── Bookable toggle ── */}
                  <div className="flex items-center justify-between bg-[#0f111a] border border-zinc-700/80 rounded-xl px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center">
                        <BookOpen size={14} className="text-purple-400" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white">Shared / Bookable Resource</p>
                        <p className="text-[11px] text-zinc-500">Employees can book this via Resource Booking</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => set("isBookable", !form.isBookable)}
                      className={`relative w-11 h-6 rounded-full transition-all duration-300 focus:outline-none
                        ${form.isBookable ? "bg-purple-500" : "bg-zinc-600"}`}
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
                      className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border border-dashed border-zinc-700 hover:border-zinc-500 transition-colors text-sm text-zinc-500 hover:text-zinc-300"
                    >
                      <Camera size={16} />
                      {form.photoFileName
                        ? <span className="text-emerald-400">✓ {form.photoFileName}</span>
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
                  <div className="flex items-start gap-2.5 bg-blue-950/30 border border-blue-500/20 rounded-xl px-4 py-3">
                    <Tag size={13} className="text-blue-400 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-blue-300/80 leading-relaxed">
                      <span className="font-semibold text-blue-300">Asset Tag</span> will be auto-generated (e.g. AF-0145) by the system after registration.
                      The asset will be set to <span className="text-emerald-400 font-semibold">Available</span> status and ready for allocation.
                    </p>
                  </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-zinc-800 flex gap-3 flex-shrink-0">
                  <button
                    onClick={onClose}
                    className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-500 hover:text-white transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={submitting}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-blue-600/20"
                  >
                    {submitting
                      ? <><Loader2 size={14} className="animate-spin" /> Registering…</>
                      : <><Check size={14} /> Register Asset</>}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
