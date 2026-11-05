import { useEffect, useRef } from "react";

/**
 * Poll a function on an interval — without the two mistakes a hand-written
 * `setInterval` always makes:
 *
 * 1. **Overlapping calls.** When the request is slower than the interval, the
 *    next call starts before the previous one finished. The answers then
 *    arrive out of order and the screen shows the older data. Here a call is
 *    skipped while the previous one is still running.
 * 2. **Polling a hidden tab.** A background tab is throttled by the browser,
 *    so the requests pile up for nobody to see. Here nothing is requested
 *    while the tab is hidden — and the moment it becomes visible again the
 *    data is refreshed, because it may be minutes old.
 *
 * The callback is kept in a ref, so a function that is re-created on every
 * render does not restart the timer.
 *
 * @param callback  the work to repeat (fetch, usually)
 * @param intervalMs how often to repeat it
 * @param enabled   set to false to stop polling (wrong role, no session, …)
 */
export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const saved = useRef(callback);
  const running = useRef(false);

  // Always call the newest callback, without restarting the timer.
  useEffect(() => {
    saved.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      // The previous call has not come back yet — do not start a second one.
      if (running.current) return;
      // Nobody is looking at a hidden tab.
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }

      running.current = true;
      try {
        await saved.current();
      } finally {
        running.current = false;
      }
    };

    // The first run happens straight away, exactly like the old code did.
    void tick();

    const id = setInterval(tick, intervalMs);
    const onVisibilityChange = () => {
      // Coming back to the tab: the data may be minutes old, so refresh now.
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
