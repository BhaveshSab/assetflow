/**
 * A searchable select that works with the keyboard.
 *
 * The old version was a `<button>` that opened a `<div>` with a search field
 * and a list of buttons. For a keyboard user that was unusable: the arrow
 * keys did nothing, `Escape` did not close it, and a screen reader had no
 * idea that a list was open.
 *
 * This is the combobox pattern of WAI-ARIA 1.2:
 *   * the search field is `role="combobox"` with `aria-expanded`,
 *     `aria-controls` and `aria-activedescendant`,
 *   * the list is `role="listbox"`, the entries are `role="option"`,
 *   * ArrowDown / ArrowUp move the highlight, Home / End jump to the ends,
 *     Enter selects, Escape closes and returns the focus to the trigger,
 *   * the number of results is announced (aria-live).
 */
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ChevronDown, Search } from "lucide-react";
import * as React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export function SearchDropdown<T>({
  label,
  placeholder,
  icon: Icon,
  items,
  selected,
  onSelect,
  renderItem,
  renderSelected,
  filterFn,
  error,
  required,
}: {
  label: string;
  placeholder: string;
  icon: React.ElementType;
  items: T[];
  selected: T | null;
  onSelect: (item: T) => void;
  renderItem: (item: T) => React.ReactNode;
  renderSelected: (item: T) => React.ReactNode;
  filterFn: (item: T, query: string) => boolean;
  error?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const triggerId = useId();
  const errorId = useId();

  const filtered = useMemo(
    () => (query ? items.filter((i) => filterFn(i, query)) : items),
    [items, query, filterFn],
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Keep the highlighted option inside the list.
  useEffect(() => {
    setActiveIndex(filtered.length > 0 ? 0 : -1);
  }, [filtered.length, open]);

  // The search field takes the focus as soon as the list opens — every time,
  // not only when the mouse was used (an effect, so it cannot race).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = (returnFocus = true) => {
    setOpen(false);
    setQuery("");
    if (returnFocus) triggerRef.current?.focus();
  };

  const choose = (item: T) => {
    onSelect(item);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  /** The keyboard of a combobox (WAI-ARIA 1.2, pattern 1.2). */
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (filtered.length === 0 ? -1 : (i + 1) % filtered.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) =>
          filtered.length === 0 ? -1 : (i - 1 + filtered.length) % filtered.length,
        );
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(filtered.length ? 0 : -1);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(filtered.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        if (activeIndex >= 0 && activeIndex < filtered.length) {
          choose(filtered[activeIndex]);
        }
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div ref={ref} className="relative">
      <label
        htmlFor={triggerId}
        className="block text-xs font-medium text-zinc-400 mb-1.5"
      >
        {label} {required && <span className="text-red-400" aria-hidden="true">*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {/* Trigger */}
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onClick={() => {
          setOpen((o) => !o);
          setQuery("");
        }}
        onKeyDown={onTriggerKeyDown}
        className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl border text-left transition-all
          ${error
            ? "border-red-500/60 bg-red-950/20"
            : open
            ? "border-blue-500/60 bg-[#0f111a]"
            : "border-zinc-700 bg-[#0f111a] hover:border-zinc-600"}`}
      >
        <Icon size={15} className="text-zinc-500 flex-shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0 text-sm">
          {selected ? renderSelected(selected) : (
            <span className="text-zinc-600">{placeholder}</span>
          )}
        </div>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`text-zinc-500 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute z-50 top-full mt-1.5 w-full bg-[#1a1d2e] border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
          >
            <div className="p-2 border-b border-zinc-800">
              <div className="relative">
                <Search
                  size={13}
                  aria-hidden="true"
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
                />
                <input
                  ref={inputRef}
                  role="combobox"
                  aria-expanded={true}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
                  }
                  aria-label={`Search ${label.toLowerCase()}`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  className="w-full bg-[#0f111a] border border-zinc-700 rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-blue-500/50"
                />
              </div>
            </div>

            {/* How many results the search found — announced, not only shown. */}
            <p role="status" aria-live="polite" className="sr-only">
              {filtered.length} {filtered.length === 1 ? "result" : "results"}
            </p>

            <div
              id={listId}
              role="listbox"
              aria-label={label}
              className="max-h-52 overflow-y-auto divide-y divide-zinc-800/50"
            >
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-zinc-500">No results found</div>
              ) : (
                filtered.map((item, i) => (
                  <button
                    key={i}
                    id={`${listId}-option-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => choose(item)}
                    className={`w-full text-left px-3.5 py-2.5 transition-colors text-sm ${
                      i === activeIndex ? "bg-zinc-700/50" : "hover:bg-zinc-700/40"
                    }`}
                  >
                    {renderItem(item)}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <p id={errorId} role="alert" className="text-red-400 text-[11px] mt-1 flex items-center gap-1">
          <AlertTriangle size={10} aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  );
}
