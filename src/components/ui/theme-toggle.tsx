import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

export interface ThemeToggleProps {
  className?: string;
}

/**
 * The light/dark switch.
 *
 * A toggle is a button with state, so it is announced as one: `aria-pressed`
 * carries the state and the label says what will happen next ("Switch to dark
 * theme") rather than what is on now — a screen-reader user hears the action,
 * not a guess. The icon is decorative (`aria-hidden`), the text is the label,
 * and the touch target keeps the 44 px height the rest of the header uses.
 */
export default function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const next = isDark ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-pressed={isDark}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-lg",
        "text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      {isDark ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
