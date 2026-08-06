import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Package,
  Boxes,
  Wrench,
  CalendarCheck,
  ShieldCheck,
  Activity,
  BarChart3,
  ArrowLeftRight,
  User,
  Crown,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Bell,
  Building2,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
export type Role = "ADMIN" | "ASSET_MANAGER" | "DEPARTMENT_HEAD" | "EMPLOYEE";

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  badge?: number | null;
  section?: string;
}

export interface SidebarUser {
  name: string;
  email: string;
  role: Role;
  avatar?: string;
}

export interface SidebarProps {
  user: SidebarUser;
  onSignOut: () => void;
  activePage: string;
  onNavigate: (pageId: string) => void;
  badges?: {
    pendingTransfers?: number;
    maintenanceRequests?: number;
    overdueReturns?: number;
    notifications?: number;
  };
}

// ─────────────────────────────────────────────────────────────
// SIDEBAR NAV CONFIG — RBAC
// ─────────────────────────────────────────────────────────────
const ALL_NAV_ITEMS: (NavItem & { allowedRoles: Role[] })[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, section: "MAIN", allowedRoles: ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD", "EMPLOYEE"] },
  { id: "asset-directory", label: "Asset Directory", icon: Boxes, section: "MAIN", allowedRoles: ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"] },

  { id: "allocations", label: "Allocations & Transfers", icon: ArrowLeftRight, section: "OPERATIONS", allowedRoles: ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD", "EMPLOYEE"] },
  { id: "booking", label: "Resource Booking", icon: CalendarCheck, section: "OPERATIONS", allowedRoles: ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD", "EMPLOYEE"] },
  { id: "maintenance", label: "Maintenance", icon: Wrench, section: "OPERATIONS", allowedRoles: ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD", "EMPLOYEE"] },

  { id: "my-assets", label: "My Assets", icon: Package, section: "MY WORKSPACE", allowedRoles: ["EMPLOYEE"] },

  { id: "audits", label: "Asset Audits", icon: ShieldCheck, section: "COMPLIANCE & DATA", allowedRoles: ["ADMIN", "ASSET_MANAGER"] },
  { id: "reports", label: "Reports & Analytics", icon: BarChart3, section: "COMPLIANCE & DATA", allowedRoles: ["ADMIN", "ASSET_MANAGER"] },

  { id: "organization", label: "Organization Setup", icon: Building2, section: "SYSTEM", allowedRoles: ["ADMIN"] },
  { id: "activity", label: "Activity Logs", icon: Activity, section: "SYSTEM", allowedRoles: ["ADMIN", "ASSET_MANAGER"] },
];

// ─────────────────────────────────────────────────────────────
// ROLE CONFIG
// ─────────────────────────────────────────────────────────────
const roleConfig: Record<Role, { label: string; color: string; icon: React.ElementType }> = {
  ADMIN:           { label: "Admin",         color: "bg-purple-500/20 text-purple-300 border border-purple-500/30", icon: Crown },
  ASSET_MANAGER:   { label: "Asset Manager", color: "bg-blue-500/20 text-blue-300 border border-blue-500/30",       icon: ShieldCheck },
  DEPARTMENT_HEAD: { label: "Dept. Head",    color: "bg-amber-500/20 text-amber-300 border border-amber-500/30",   icon: Briefcase },
  EMPLOYEE:        { label: "Employee",      color: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30", icon: User },
};

const avatarColors = ["bg-blue-600", "bg-purple-600", "bg-emerald-600", "bg-amber-600", "bg-rose-600", "bg-cyan-600"];
const getAvatarColor = (name: string) => avatarColors[name.charCodeAt(0) % avatarColors.length];

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────
const Sidebar = ({ user, onSignOut, activePage, onNavigate, badges = {} }: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showSignout, setShowSignout] = useState(false);

  const allowedItems = ALL_NAV_ITEMS.filter((item) => item.allowedRoles.includes(user.role));

  const sections = allowedItems.reduce<Record<string, NavItem[]>>((acc, item) => {
    const sec = item.section ?? "MAIN";
    if (!acc[sec]) acc[sec] = [];
    acc[sec].push(item);
    return acc;
  }, {});

  const getBadge = (id: string): number | null => {
    if (id === "allocations") return badges.pendingTransfers ?? null;
    if (id === "maintenance") return badges.maintenanceRequests ?? null;
    if (id === "asset-directory") return badges.overdueReturns ?? null;
    return null;
  };

  const initials = user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  const roleCfg = roleConfig[user.role];
  const RoleIcon = roleCfg.icon;

  const handleNav = (id: string) => {
    onNavigate(id);
    setMobileOpen(false);
  };

  return (
    <>
      {/* ── MOBILE OVERLAY ── */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* ── MOBILE HAMBURGER ── */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-[#1a1d2e] border border-zinc-700 rounded-xl text-gray-400 hover:text-white transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* ── SIDEBAR ── */}
      <motion.aside
        animate={{ width: collapsed ? 68 : 220 }}
        transition={{ type: "spring" as const, stiffness: 300, damping: 30 }}
        className={`
          fixed top-0 left-0 h-screen z-50
          bg-[#0f111a] border-r border-zinc-800/60
          flex flex-col
          shadow-[4px_0_24px_rgba(0,0,0,0.4)]
          transition-transform duration-300
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          lg:translate-x-0 lg:relative lg:flex
        `}
      >
        {/* ── LOGO ── */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800/60 flex-shrink-0">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-blue-600/30">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                <rect x="2" y="3" width="7" height="7" rx="1.5" />
                <rect x="15" y="3" width="7" height="7" rx="1.5" />
                <rect x="2" y="14" width="7" height="7" rx="1.5" />
                <path d="M15 17.5h7M18.5 14v7" />
              </svg>
            </div>
            <AnimatePresence>
              {!collapsed && (
                <motion.span
                  initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={{ opacity: 0, width: 0 }}
                  className="text-base font-extrabold text-white tracking-tight whitespace-nowrap overflow-hidden"
                >
                  AssetFlow
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          <button
            onClick={() => setCollapsed((c) => !c)}
            className="hidden lg:flex p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-zinc-800 transition-all flex-shrink-0"
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* ── NAV SECTIONS ── */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 px-2 space-y-5">
          {Object.entries(sections).map(([section, items]) => (
            <div key={section}>
              <AnimatePresence>
                {!collapsed && (
                  <motion.p
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest px-2 mb-1.5"
                  >
                    {section}
                  </motion.p>
                )}
              </AnimatePresence>

              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activePage === item.id;
                  const badge = getBadge(item.id);

                  return (
                    <motion.button
                      key={item.id}
                      whileHover={{ x: collapsed ? 0 : 2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => handleNav(item.id)}
                      title={collapsed ? item.label : undefined}
                      className={`
                        w-full flex items-center gap-3 px-2.5 py-2 rounded-xl transition-all duration-150 text-left relative group
                        ${isActive
                          ? "bg-blue-600/20 text-blue-400 border border-blue-500/25 shadow-sm"
                          : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 border border-transparent"}
                        ${collapsed ? "justify-center" : ""}
                      `}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="activeBar"
                          className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-blue-400 rounded-full"
                        />
                      )}

                      <Icon size={17} className={`flex-shrink-0 ${isActive ? "text-blue-400" : ""}`} />

                      <AnimatePresence>
                        {!collapsed && (
                          <motion.span
                            initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={{ opacity: 0, width: 0 }}
                            className="text-[13px] font-medium flex-1 whitespace-nowrap overflow-hidden"
                          >
                            {item.label}
                          </motion.span>
                        )}
                      </AnimatePresence>

                      {badge !== null && badge > 0 && !collapsed && (
                        <span className="flex-shrink-0 text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                          {badge > 99 ? "99+" : badge}
                        </span>
                      )}

                      {badge !== null && badge > 0 && collapsed && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-amber-400 rounded-full" />
                      )}

                      {collapsed && (
                        <div className="absolute left-full ml-3 px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap shadow-xl z-50">
                          {item.label}
                          {badge !== null && badge > 0 && (
                            <span className="ml-1.5 text-amber-400">({badge})</span>
                          )}
                        </div>
                      )}
                    </motion.button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* ── USER PROFILE SECTION ── */}
        <div className="border-t border-zinc-800/60 p-3 flex-shrink-0">
          <AnimatePresence>
            {!collapsed ? (
              <motion.div
                key="expanded" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2"
              >
                <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-zinc-800/40 border border-zinc-800">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0 ${getAvatarColor(user.name)}`}>
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-white truncate">{user.name}</p>
                    <p className="text-[10px] text-zinc-500 truncate">{user.email}</p>
                  </div>
                  <button className="relative p-1 rounded-lg hover:bg-zinc-700 transition-colors flex-shrink-0">
                    <Bell size={13} className="text-zinc-400" />
                    {(badges.notifications ?? 0) > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-red-500 rounded-full text-[8px] text-white font-bold flex items-center justify-center">
                        {badges.notifications}
                      </span>
                    )}
                  </button>
                </div>

                <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-semibold ${roleCfg.color}`}>
                  <RoleIcon size={11} />
                  {roleCfg.label}
                  {user.role === "ADMIN" && (
                    <span className="ml-auto text-[9px] bg-purple-500/20 px-1 rounded">ADMIN</span>
                  )}
                </div>

                <button
                  onClick={() => setShowSignout(true)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all text-[12px] font-medium"
                >
                  <LogOut size={13} />
                  Sign Out
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="collapsed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-2"
              >
                <div
                  title={`${user.name} — ${roleCfg.label}`}
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white ${getAvatarColor(user.name)}`}
                >
                  {initials}
                </div>
                <button
                  onClick={() => setShowSignout(true)}
                  title="Sign Out"
                  className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                  <LogOut size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.aside>

      {/* ── SIGN OUT CONFIRM ── */}
      <AnimatePresence>
        {showSignout && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[200] flex items-center justify-center p-4"
            onClick={() => setShowSignout(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[#1a1d2e] border border-zinc-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl text-center"
            >
              <div className="w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center mx-auto mb-4">
                <LogOut size={22} className="text-red-400" />
              </div>
              <h3 className="text-white font-bold text-base mb-1">Sign out of AssetFlow?</h3>
              <p className="text-gray-400 text-sm mb-6">You'll need to log back in to access your workspace.</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowSignout(false)}
                  className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-gray-400 text-sm hover:border-zinc-500 hover:text-white transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setShowSignout(false); onSignOut(); }}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all"
                >
                  Sign Out
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default Sidebar;
