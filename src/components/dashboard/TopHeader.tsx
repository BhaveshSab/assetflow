import { Menu } from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import NotificationBell from "@/components/dashboard/NotificationBell";
import ThemeToggle from "@/components/ui/theme-toggle";

export interface TopHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  onMobileMenuToggle?: () => void;
  /** Display name of the signed-in user (used for the avatar initials). */
  userName?: string;
  /** The user's picture, when they have set one. */
  avatarUrl?: string;
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
  avatarUrl,
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

        {/* Avatar — initials are rendered by React (no innerHTML).
            It used to be a div with a pointer cursor, a hover animation and
            no behaviour at all: it *looked* like the way into your account and
            did nothing. It is now a link to /profile, which is where the name,
            picture, password and "sign out everywhere" live. */}
        <motion.span whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.95 }}>
          <Link
            to="/profile"
            aria-label={
              userName ? `Your profile (${userName})` : "Your profile"
            }
            title={userName ? `${userName} — your profile` : "Your profile"}
            className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-info text-xs font-semibold text-white ring-2 ring-line-strong transition-all hover:ring-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                width={32}
                height={32}
                referrerPolicy="no-referrer"
                className="h-8 w-8 object-cover"
              />
            ) : (
              <span aria-hidden="true">{initialsOf(userName)}</span>
            )}
          </Link>
        </motion.span>
      </div>
    </motion.header>
  );
}
