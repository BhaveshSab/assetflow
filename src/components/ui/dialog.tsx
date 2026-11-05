/**
 * An accessible modal dialog.
 *
 * Why this file exists: every overlay used to be a plain `<div>` with
 * `fixed inset-0`. That broke four WCAG 2.0 success criteria at once:
 *
 *   * **4.1.2 Name, Role, Value** — a screen reader did not announce
 *     "dialog", and the dialog had no accessible name at all.
 *   * **2.4.3 Focus Order** — `Tab` walked straight out of the dialog into
 *     the page behind it, so a keyboard user ended up clicking invisible
 *     controls.
 *   * **2.1.1 / 2.1.2 Keyboard** — `Escape` did not close the dialog.
 *   * **2.4.3 Focus Order** — when the dialog closed, the focus was lost
 *     (the browser put it back on `<body>`), so the user had to tab from the
 *     top of the page again.
 *
 * On top of that the page behind kept scrolling, and the overlay was trapped
 * inside the component tree (so a parent with `overflow-hidden` clipped it).
 *
 * All of that is solved once, here, for every overlay in the app:
 *   * `role="dialog"` + `aria-modal="true"` + an accessible name,
 *   * a focus trap (`Tab` cycles inside),
 *   * `Escape` closes,
 *   * the focus returns to the element that opened the dialog,
 *   * the background cannot scroll while the dialog is open,
 *   * the overlay is rendered in a portal, so no ancestor can clip it.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, AlertTriangle, X } from "lucide-react";

import { cn } from "@/lib/utils";

/** Everything that can hold the keyboard focus. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Is the element actually visible?
 *
 * `getClientRects()` would be the obvious check, but it needs a layout engine
 * — jsdom has none, so every element would look hidden in the tests. The
 * computed style is enough: `display: none` and `visibility: hidden` are the
 * two ways an element is removed from the tab order.
 */
function isVisible(element: HTMLElement): boolean {
  if (element.hasAttribute("hidden")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** The focusable elements inside a container, in DOM order. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    isVisible,
  );
}

export interface DialogProps {
  /** Is the dialog open? The exit animation still plays when it flips to false. */
  open: boolean;
  /** Called on Escape, on the backdrop click and on the close button. */
  onClose: () => void;
  /**
   * The accessible name of the dialog. It is rendered as a visible heading
   * unless `titleHidden` is set — then it is only announced.
   */
  title: string;
  /** An optional description, announced together with the title. */
  description?: string;
  /**
   * The id of an element the caller renders as the description. Used when
   * the description is already on the screen — otherwise a screen reader
   * would read it twice (once from here, once from the visible text).
   */
  describedById?: string;
  /** The body of the dialog. */
  children?: React.ReactNode;
  /** The action row (usually the buttons). */
  footer?: React.ReactNode;
  /** The consumer renders its own visible heading — the title is announced only. */
  titleHidden?: boolean;
  /** Close when the backdrop is clicked (default: true). */
  closeOnBackdrop?: boolean;
  /** Close on Escape (default: true). */
  closeOnEscape?: boolean;
  /** Extra classes for the panel (the card in the middle). */
  panelClassName?: string;
  /** Extra classes for the backdrop. */
  backdropClassName?: string;
  /** The test id of the panel. */
  testId?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  describedById,
  children,
  footer,
  titleHidden = false,
  closeOnBackdrop = true,
  closeOnEscape = true,
  panelClassName,
  backdropClassName,
  testId = "dialog",
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  // ── the focus goes into the dialog and comes back out again ─────────────
  React.useEffect(() => {
    if (!open) return;

    // Remember where the focus came from, so it can be restored on close.
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    // Move the focus inside: the first focusable element, or the panel.
    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const elements = focusableWithin(panel);
      (elements[0] ?? panel).focus();
    };
    // The panel exists only after the portal is rendered.
    const frame = requestAnimationFrame(focusFirst);

    return () => {
      cancelAnimationFrame(frame);
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  // ── Escape closes, Tab stays inside ─────────────────────────────────────
  React.useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeOnEscape) {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const elements = focusableWithin(panel);
      if (elements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, closeOnEscape]);

  // ── the page behind must not scroll while the dialog is open ───────────
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={cn(
            "fixed inset-0 bg-black/80 backdrop-blur-sm z-[300] flex items-center justify-center p-4",
            backdropClassName,
          )}
          onClick={closeOnBackdrop ? onClose : undefined}
          data-testid={`${testId}-backdrop`}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={titleHidden ? title : undefined}
            aria-labelledby={titleHidden ? undefined : titleId}
            aria-describedby={
              describedById ?? (description ? descriptionId : undefined)
            }
            tabIndex={-1}
            initial={{ scale: 0.93, opacity: 0, y: 24 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.93, opacity: 0, y: 24 }}
            transition={{ type: "spring", damping: 26, stiffness: 300 }}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "bg-[#1a1d2e] border border-zinc-700/80 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden max-h-[95vh] flex flex-col",
              panelClassName,
            )}
            data-testid={testId}
          >
            {!titleHidden && (
              <h2
                id={titleId}
                className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-10 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-zinc-900"
              >
                {title}
              </h2>
            )}

            {description && !describedById && (
              <p id={descriptionId} className="sr-only">
                {description}
              </p>
            )}

            {children}

            {footer && (
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 border-t border-zinc-700/60 px-6 py-4">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** The destructive action — the confirm button is red. */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirmation before a destructive action (rejecting a transfer, deleting
 * a record). Without it, one mis-click on a row button sends the request.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const messageId = React.useId();

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      describedById={messageId}
      panelClassName="max-w-sm text-center"
      testId="confirm-dialog"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-gray-400 text-sm hover:border-zinc-500 hover:text-white transition-all"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              "flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-60",
              destructive
                ? "bg-red-500/90 text-white hover:bg-red-500"
                : "bg-blue-600 text-white hover:bg-blue-500",
            )}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="px-6 py-8">
        <div
          className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${
            destructive ? "bg-red-500/20" : "bg-amber-500/20"
          }`}
          aria-hidden="true"
        >
          {destructive ? (
            <AlertTriangle size={22} className="text-red-400" />
          ) : (
            <AlertCircle size={22} className="text-amber-400" />
          )}
        </div>
        <p id={messageId} className="text-sm text-gray-400">
          {message}
        </p>
      </div>
    </Dialog>
  );
}

/** The close button of a dialog — it needs a name, so it gets an aria-label. */
export function DialogCloseButton({
  onClick,
  label = "Close",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
    >
      <X size={18} />
    </button>
  );
}
