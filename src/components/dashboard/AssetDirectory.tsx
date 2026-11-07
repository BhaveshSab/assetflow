import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Filter,
  MoreVertical,
  Plus,
  Laptop,
  Car,
  Monitor,
  Armchair,
  Box,
  AlertCircle,
  CheckCircle2,
  X,
} from "lucide-react";

import { getAssets, type Asset } from "@/api/assetServices";
import AllocateAssetModal, { type Asset as ModalAsset } from "@/components/dashboard/AllocateAssetModal";
import RegisterAssetModal from "@/components/dashboard/RegisterAssetModal";

interface Toast { msg: string; type: string; }

// Animation variants for staggered row entrance
const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 300, damping: 24 },
  },
  exit: { opacity: 0, x: -10, transition: { duration: 0.2 } },
};

const statusStyles: Record<string, string> = {
  Available: "bg-success/10 text-success border-success/20",
  Allocated: "bg-info/10 text-info border-info/20",
  "Under Maintenance": "bg-warning/10 text-warning border-warning/20",
  Lost: "bg-danger/10 text-danger border-danger/20",
};

// Helper to map backend category strings to icons
const getCategoryIcon = (category: string) => {
  const cat = category?.toLowerCase() || "";
  if (cat.includes("electronic") || cat.includes("laptop"))
    return <Laptop size={18} />;
  if (cat.includes("vehicle") || cat.includes("car"))
    return <Car size={18} />;
  if (cat.includes("screen") || cat.includes("monitor"))
    return <Monitor size={18} />;
  if (cat.includes("furniture") || cat.includes("chair"))
    return <Armchair size={18} />;
  return <Box size={18} />;
};

export default function AssetDirectory() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  // The two filter controls used to be buttons that did nothing at all. They
  // are now <select>s bound to real state, and the list below respects them.
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAllocate, setShowAllocate] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [preSelectedAsset, setPreSelectedAsset] = useState<ModalAsset | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ==========================================
  // BACKEND INTEGRATION: Fetch Asset Data
  // ==========================================
  useEffect(() => {
    const fetchAssets = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const data = await getAssets();
        setAssets(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unexpected error occurred."
        );
      } finally {
        setIsLoading(false);
      }
    };

    void fetchAssets();
  }, []);

  // ==========================================
  // FILTERING LOGIC
  // ==========================================
  // Only the categories and statuses that actually occur, so the menu never
  // offers a choice that would empty the table.
  const categories = useMemo(
    () =>
      Array.from(new Set(assets.map((a) => a.category).filter(Boolean))).sort(),
    [assets],
  );
  const statuses = useMemo(
    () =>
      Array.from(new Set(assets.map((a) => a.status).filter(Boolean))).sort(),
    [assets],
  );

  const filteredAssets = assets.filter((asset) => {
    const searchLower = searchTerm.toLowerCase();
    const matchesSearch =
      asset.name?.toLowerCase().includes(searchLower) ||
      asset.assetTag?.toLowerCase().includes(searchLower) ||
      asset.category?.toLowerCase().includes(searchLower);
    const matchesCategory =
      categoryFilter === "all" || asset.category === categoryFilter;
    const matchesStatus = statusFilter === "all" || asset.status === statusFilter;
    return Boolean(matchesSearch && matchesCategory && matchesStatus);
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full space-y-6"
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
            Asset Directory
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Manage and track all organizational assets
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => setShowRegister(true)}
          className="flex items-center gap-2 bg-info hover:bg-info text-white px-4 py-2 rounded-lg text-sm font-medium shadow-lg shadow-blue-900/20 transition-colors"
        >
          <Plus size={16} />
          Register New Asset
        </motion.button>
      </div>

      {/* --- Toolbar --- */}
      <div className="bg-surface-2 border border-line/80 rounded-2xl p-4 shadow-xl flex flex-col md:flex-row gap-4 justify-between items-center relative overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-info/5 rounded-full blur-3xl pointer-events-none"></div>

        <div className="relative w-full md:w-96">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
            size={18}
          />
          <input
            type="text"
            placeholder="Search by Asset Tag, Name, or Category..."
            className="w-full bg-canvas border border-line text-ink text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-info/50 transition-all placeholder:text-ink-faint"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="flex w-full md:w-auto gap-3">
          <div className="relative w-full md:w-auto">
            <Filter
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <label htmlFor="filter-category" className="sr-only">
              Filter by category
            </label>
            <select
              id="filter-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full appearance-none bg-canvas border border-line text-ink-soft pl-9 pr-8 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-info/50 md:w-auto"
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div className="relative w-full md:w-auto">
            <Filter
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <label htmlFor="filter-status" className="sr-only">
              Filter by status
            </label>
            <select
              id="filter-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full appearance-none bg-canvas border border-line text-ink-soft pl-9 pr-8 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-info/50 md:w-auto"
            >
              <option value="all">All statuses</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* --- Error State --- */}
      {error && (
        <div role="alert" className="bg-danger/10 border border-danger/20 rounded-xl p-4 flex items-center gap-4 text-danger">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="ml-auto underline text-sm hover:text-danger"
          >
            Retry Fetch
          </button>
        </div>
      )}

      {/* --- Data Table --- */}
      <div className="bg-surface-2 border border-line/80 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-line bg-surface-2/50">
                <th className="py-4 px-6 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                  Asset Info
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                  Category
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                  Location
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                  Status
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-ink-muted uppercase tracking-wider text-right">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-line/50">
              {/* --- Skeleton Loading State --- */}
              {isLoading &&
                !error &&
                Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={`skeleton-${idx}`} className="animate-pulse">
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-surface-3 rounded-lg"></div>
                        <div className="space-y-2">
                          <div className="h-4 bg-surface-3 rounded w-32"></div>
                          <div className="h-3 bg-surface-3 rounded w-20"></div>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-6">
                      <div className="h-4 bg-surface-3 rounded w-24"></div>
                    </td>
                    <td className="py-4 px-6">
                      <div className="h-4 bg-surface-3 rounded w-28"></div>
                    </td>
                    <td className="py-4 px-6">
                      <div className="h-6 bg-surface-3 rounded-full w-20"></div>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <div className="h-6 w-6 bg-surface-3 rounded-lg ml-auto"></div>
                    </td>
                  </tr>
                ))}
            </tbody>

            {/* --- Actual Data Rows --- */}
            {!isLoading && !error && (
              <motion.tbody
                variants={containerVariants}
                initial="hidden"
                animate="show"
                className="divide-y divide-line/50"
              >
                <AnimatePresence>
                  {filteredAssets.length === 0 ? (
                    <motion.tr
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                    >
                      <td colSpan={5} className="py-12 text-center text-ink-subtle">
                        <Box size={40} className="mx-auto mb-3 opacity-20" />
                        No assets found. Try adjusting your search.
                      </td>
                    </motion.tr>
                  ) : (
                    filteredAssets.map((asset) => (
                      <motion.tr
                        key={asset.id || asset.assetTag}
                        variants={itemVariants}
                        layout
                        className="hover:bg-surface-3/30 transition-colors group"
                      >
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-surface-3/50 rounded-lg text-ink-muted group-hover:text-info group-hover:bg-info/10 transition-colors">
                              {getCategoryIcon(asset.category)}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-ink">
                                {asset.name}
                              </p>
                              <p className="text-xs text-ink-subtle font-mono mt-0.5">
                                {asset.assetTag}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-6">
                          <span className="text-sm text-ink-muted">
                            {asset.category}
                          </span>
                        </td>
                        <td className="py-4 px-6">
                          <span className="text-sm text-ink-muted">
                            {asset.location || "Unassigned"}
                          </span>
                        </td>
                        <td className="py-4 px-6">
                          <span
                            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                              statusStyles[asset.status] ||
                              "bg-ink-subtle/10 text-ink-muted border-line-strong/20"
                            }`}
                          >
                            {asset.status || "Unknown"}
                          </span>
                        </td>
                        <td className="py-4 px-6 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {asset.status === "Available" && (
                              <button
                                onClick={() => {
                                  setPreSelectedAsset({
                                    ...asset,
                                    condition: "Good",
                                    status: "Available",
                                  } as ModalAsset);
                                  setShowAllocate(true);
                                }}
                                className="px-2.5 py-1 text-xs bg-info/20 text-info border border-info/30 rounded-lg hover:bg-info/30 transition-colors"
                              >
                                Allocate
                              </button>
                            )}
                            <button className="text-ink-subtle hover:text-ink p-1.5 rounded-lg hover:bg-surface-3 transition-colors" aria-label="More actions" disabled>
                              <MoreVertical size={18} />
                            </button>
                          </div>
                        </td>
                      </motion.tr>
                    ))
                  )}
                </AnimatePresence>
              </motion.tbody>
            )}
          </table>
        </div>
      </div>

      {/* Allocate Asset Modal */}
      <AllocateAssetModal
        open={showAllocate}
        onClose={() => { setShowAllocate(false); setPreSelectedAsset(null); }}
        onSuccess={(allocationId) => {
          setShowAllocate(false);
          setPreSelectedAsset(null);
          showToast(`Asset allocated successfully! ID: ${allocationId}`);
          getAssets().then(setAssets).catch(() => {});
        }}
        preSelectedAsset={preSelectedAsset}
      />

      {/* Register Asset Modal */}
      <RegisterAssetModal
        open={showRegister}
        onClose={() => setShowRegister(false)}
        onSuccess={(newAsset) => {
          setShowRegister(false);
          showToast(`Asset "${newAsset.name}" registered! Tag: ${newAsset.assetTag}`);
          // Refresh asset list to show the new asset
          setIsLoading(true);
          getAssets()
            .then(setAssets)
            .catch(() => {})
            .finally(() => setIsLoading(false));
        }}
      />
    </motion.div>
  );
}
