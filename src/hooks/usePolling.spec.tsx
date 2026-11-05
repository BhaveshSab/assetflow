import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePolling } from "@/hooks/usePolling";

function Poller({
  callback,
  interval = 1000,
  enabled = true,
}: {
  callback: () => void | Promise<void>;
  interval?: number;
  enabled?: boolean;
}) {
  usePolling(callback, interval, enabled);
  return null;
}

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The tests drive the visibility by hand.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the callback straight away and then on the interval", async () => {
    const callback = vi.fn();
    render(<Poller callback={callback} interval={1000} />);

    expect(callback).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it("does not start a second call while the first one is still running", async () => {
    let resolve: (() => void) | undefined;
    const callback = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );

    render(<Poller callback={callback} interval={1000} />);
    expect(callback).toHaveBeenCalledTimes(1);

    // Three intervals pass while the first request is still in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    // The request finally comes back — the next tick is allowed again.
    await act(async () => {
      resolve?.();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not poll a hidden tab", async () => {
    const callback = vi.fn();
    render(<Poller callback={callback} interval={1000} />);
    expect(callback).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("refreshes as soon as the tab becomes visible again", async () => {
    const callback = vi.fn();
    render(<Poller callback={callback} interval={1000} />);
    expect(callback).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not poll at all when it is switched off", async () => {
    const callback = vi.fn();
    render(<Poller callback={callback} interval={1000} enabled={false} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("stops when the component goes away", async () => {
    const callback = vi.fn();
    const { unmount } = render(<Poller callback={callback} interval={1000} />);
    expect(callback).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
