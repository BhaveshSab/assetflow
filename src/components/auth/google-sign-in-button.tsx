import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { apiGoogleSignIn, type AuthResponse } from "@/lib/auth";
import { loadGoogleIdentity } from "@/lib/google";

interface GoogleSignInButtonProps {
  clientId: string;
  disabled?: boolean;
  onSuccess: (session: AuthResponse) => void;
  onError: (message: string) => void;
}

/**
 * The real "Sign in with Google" control.
 *
 * Google's script renders its own button (that is what makes the account
 * picker trustworthy); this component only sizes it, loads it once, and sends
 * the resulting ID token to `POST /auth/google`.
 */
export function GoogleSignInButton({
  clientId,
  disabled = false,
  onSuccess,
  onError,
}: GoogleSignInButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSuccess, onError });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);

  // Keep the latest callbacks without re-initialising Google on every render.
  useEffect(() => {
    callbacks.current = { onSuccess, onError };
  });

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    loadGoogleIdentity()
      .then(() => {
        if (cancelled || !containerRef.current) return;

        const google = window.google;
        if (!google?.accounts?.id) {
          setStatus("error");
          callbacks.current.onError("Google sign-in could not load.");
          return;
        }

        google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: "popup",
          callback: async (response) => {
            if (!response.credential) {
              callbacks.current.onError(
                "Google did not return a credential. Please try again.",
              );
              return;
            }

            setBusy(true);
            try {
              const session = await apiGoogleSignIn(response.credential);
              callbacks.current.onSuccess(session);
            } catch (err) {
              callbacks.current.onError(
                err instanceof Error ? err.message : "Google sign-in failed.",
              );
            } finally {
              setBusy(false);
            }
          },
        });

        containerRef.current.innerHTML = "";
        const width = Math.min(
          Math.max(containerRef.current.offsetWidth || 200, 200),
          400,
        );
        google.accounts.id.renderButton(containerRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width,
        });
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
        callbacks.current.onError(
          "Google sign-in could not load. Check your connection and try again.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (status === "error") {
    return (
      <div className="flex h-11 items-center justify-center rounded-md border border-input px-3 text-xs text-muted-foreground">
        Google unavailable
      </div>
    );
  }

  return (
    <div className="relative h-11 w-full overflow-hidden rounded-md">
      <div
        ref={containerRef}
        aria-busy={status === "loading" || busy}
        className={
          disabled || busy
            ? "pointer-events-none flex h-11 w-full items-center justify-center opacity-60"
            : "flex h-11 w-full items-center justify-center"
        }
      />
      {(status === "loading" || busy) && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/70">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </span>
      )}
    </div>
  );
}
