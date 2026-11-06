import { Menu } from "lucide-react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import NotificationBell from "@/components/dashboard/NotificationBell";
import ThemeToggle from "@/components/ui/theme-toggle";

export interface TopHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  onMobileMenuToggle?: () => void;
  /** Display name of the signed-in user (used for the avatar initials). */
  userName?: string;
}

/** Initials for the avatar fallback — "Ada Lovelace" → "AL". */
export function initialsOf(name?: string): string {
  if (!name) return "?";
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() || "?"
  );
}

export default function TopHeader({
  className,
  onMobileMenuToggle,
  userName,
}: TopHeaderProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className={cn(
        "flex h-14 items-center justify-between border-b border-line bg-canvas px-4 sm:px-6",
        className
      )}
    >
      {/* ── Left: mobile menu toggle ──────────────────────────── */}
      <div className="flex items-center">
        <motion.button
          type="button"
          aria-label="Toggle the navigation menu"
          onClick={onMobileMenuToggle}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.9 }}
          className="inline-flex items-center justify-center rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-3/60 hover:text-ink lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </motion.button>
      </div>

      {/* ── Right: actions ─────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        {/* Light / dark switch — the choice is remembered per browser. */}
        <ThemeToggle />

        {/* Real notification bell (live backend data) */}
        <NotificationBell />

        {/* Avatar — initials are rendered by React (no innerHTML). */}
        <motion.div
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          title={userName}
          className="flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-info text-xs font-semibold text-white ring-2 ring-line-strong transition-all hover:ring-info"
        >
          <span aria-hidden="true">{initialsOf(userName)}</span>
          <span className="sr-only">{userName ?? "Signed in user"}</span>
        </motion.div>
      </div>
    </motion.header>
  );
}
