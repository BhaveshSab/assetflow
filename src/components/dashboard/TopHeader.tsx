import { Menu } from "lucide-react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import NotificationBell from "@/components/dashboard/NotificationBell";

export interface TopHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  onMobileMenuToggle?: () => void;
}

export default function TopHeader({
  className,
  onMobileMenuToggle,
}: TopHeaderProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className={cn(
        "flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 sm:px-6",
        className
      )}
    >
      {/* ── Left: mobile menu toggle ──────────────────────────── */}
      <div className="flex items-center">
        <motion.button
          type="button"
          onClick={onMobileMenuToggle}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.9 }}
          className="inline-flex items-center justify-center rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </motion.button>
      </div>

      {/* ── Right: actions ─────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        {/* Real notification bell (live backend data) */}
        <NotificationBell />

        {/* Avatar */}
        <motion.div
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          className="relative h-8 w-8 cursor-pointer overflow-hidden rounded-full ring-2 ring-zinc-700 transition-all hover:ring-blue-500"
        >
          <img
            src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=80&h=80&q=80"
            alt="User avatar"
            className="h-full w-full object-cover"
            onError={(e) => {
              const el = e.currentTarget;
              el.style.display = "none";
              el.parentElement!.classList.add(
                "bg-blue-600", "flex", "items-center", "justify-center"
              );
              el.parentElement!.innerHTML =
                '<span class="text-xs font-semibold text-white">JD</span>';
            }}
          />
        </motion.div>
      </div>
    </motion.header>
  );
}
