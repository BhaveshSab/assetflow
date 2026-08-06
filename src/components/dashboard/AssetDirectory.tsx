import { useState, useEffect } from "react";
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
  Available: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Allocated: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  "Under Maintenance": "bg-amber-500/10 text-amber-400 border-amber-500/20",
  Lost: "bg-red-500/10 text-red-400 border-red-500/20",
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

    fetchAssets();
  }, []);

  // ==========================================
  // FILTERING LOGIC
  // ==========================================
  const filteredAssets = assets.filter((asset) => {
    const searchLower = searchTerm.toLowerCase();
    return (
      asset.name?.toLowerCase().includes(searchLower) ||
      asset.assetTag?.toLowerCase().includes(searchLower) ||
      asset.category?.toLowerCase().includes(searchLower)
    );
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
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl text-sm font-medium shadow-xl border ${toast.type === "error" ? "bg-red-950 border-red-500/40 text-red-300" : "bg-emerald-950 border-emerald-500/40 text-emerald-300"}`}
          >{toast.type === "error" ? <X size={14} className="inline mr-1.5" /> : <CheckCircle2 size={14} className="inline mr-1.5" />}{toast.msg}</motion.div>
        )}
      </AnimatePresence>
      {/* --- Page Header --- */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Asset Directory
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Manage and track all organizational assets
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => setShowRegister(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-lg shadow-blue-900/20 transition-colors"
        >
          <Plus size={16} />
          Register New Asset
        </motion.button>
      </div>

      {/* --- Toolbar --- */}
      <div className="bg-[#161925] border border-zinc-800/80 rounded-2xl p-4 shadow-xl flex flex-col md:flex-row gap-4 justify-between items-center relative overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl pointer-events-none"></div>

        <div className="relative w-full md:w-96">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
            size={18}
          />
          <input
            type="text"
            placeholder="Search by Asset Tag, Name, or Category..."
            className="w-full bg-[#0f111a] border border-zinc-800 text-white text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="flex w-full md:w-auto gap-3">
          <button className="flex items-center gap-2 bg-[#0f111a] border border-zinc-800 hover:border-zinc-700 text-gray-300 px-4 py-2.5 rounded-xl text-sm font-medium transition-all w-full md:w-auto justify-center">
            <Filter size={16} className="text-gray-400" />
            Category
          </button>
          <button className="flex items-center gap-2 bg-[#0f111a] border border-zinc-800 hover:border-zinc-700 text-gray-300 px-4 py-2.5 rounded-xl text-sm font-medium transition-all w-full md:w-auto justify-center">
            <Filter size={16} className="text-gray-400" />
            Status
          </button>
        </div>
      </div>

      {/* --- Error State --- */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-4 text-red-400">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="ml-auto underline text-sm hover:text-red-300"
          >
            Retry Fetch
          </button>
        </div>
      )}

      {/* --- Data Table --- */}
      <div className="bg-[#161925] border border-zinc-800/80 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-800 bg-[#161925]/50">
                <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Asset Info
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Category
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Location
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider text-right">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-800/50">
              {/* --- Skeleton Loading State --- */}
              {isLoading &&
                !error &&
                Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={`skeleton-${idx}`} className="animate-pulse">
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-zinc-800 rounded-lg"></div>
                        <div className="space-y-2">
                          <div className="h-4 bg-zinc-800 rounded w-32"></div>
                          <div className="h-3 bg-zinc-800 rounded w-20"></div>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-6">
                      <div className="h-4 bg-zinc-800 rounded w-24"></div>
                    </td>
                    <td className="py-4 px-6">
                      <div className="h-4 bg-zinc-800 rounded w-28"></div>
                    </td>
                    <td className="py-4 px-6">
                      <div className="h-6 bg-zinc-800 rounded-full w-20"></div>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <div className="h-6 w-6 bg-zinc-800 rounded-lg ml-auto"></div>
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
                className="divide-y divide-zinc-800/50"
              >
                <AnimatePresence>
                  {filteredAssets.length === 0 ? (
                    <motion.tr
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                    >
                      <td colSpan={5} className="py-12 text-center text-gray-500">
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
                        className="hover:bg-zinc-800/30 transition-colors group"
                      >
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-zinc-800/50 rounded-lg text-gray-400 group-hover:text-blue-400 group-hover:bg-blue-500/10 transition-colors">
                              {getCategoryIcon(asset.category)}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-gray-200">
                                {asset.name}
                              </p>
                              <p className="text-xs text-zinc-500 font-mono mt-0.5">
                                {asset.assetTag}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-6">
                          <span className="text-sm text-gray-400">
                            {asset.category}
                          </span>
                        </td>
                        <td className="py-4 px-6">
                          <span className="text-sm text-gray-400">
                            {asset.location || "Unassigned"}
                          </span>
                        </td>
                        <td className="py-4 px-6">
                          <span
                            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                              statusStyles[asset.status] ||
                              "bg-gray-500/10 text-gray-400 border-gray-500/20"
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
                                className="px-2.5 py-1 text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-lg hover:bg-blue-500/30 transition-colors"
                              >
                                Allocate
                              </button>
                            )}
                            <button className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-zinc-800 transition-colors">
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
