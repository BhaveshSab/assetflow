import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown above the message — usually the name of the area that failed. */
  area?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches a rendering error and shows a human message instead of a blank
 * page.
 *
 * Without it, one broken chart took the whole application down: the user
 * saw "Something went wrong" in the console — nothing on the screen — and
 * lost the session they were working in. Here the app keeps running, the
 * message says what happened, and the user can try again without a reload.
 *
 * React error boundaries have to be class components.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console for the developer; the user sees the panel below.
    console.error("AssetFlow — a component failed to render:", error, info);
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  private readonly reload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="min-h-screen bg-zinc-950 flex items-center justify-center p-6"
      >
        <div className="max-w-md w-full bg-[#1a1d2e] border border-zinc-700 rounded-2xl p-8 text-center shadow-2xl">
          <div
            className="w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center mx-auto mb-5"
            aria-hidden="true"
          >
            <span className="text-red-400 text-2xl font-bold">!</span>
          </div>

          <h1 className="text-white font-bold text-lg mb-2">
            {this.props.area ? `The ${this.props.area} could not be shown` : "Something went wrong"}
          </h1>

          <p className="text-zinc-400 text-sm mb-1">
            The rest of AssetFlow still works. You can try that part again, or
            reload the page if it keeps happening.
          </p>

          <p className="text-zinc-500 text-xs font-mono mb-6 break-words">
            {error.message}
          </p>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={this.reset}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-300 text-sm hover:border-zinc-500 transition-all"
            >
              Reload the page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
