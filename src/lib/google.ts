/**
 * Minimal Google Identity Services loader.
 *
 * The official GIS script renders the button and hands the page a signed ID
 * token. The token is verified by the backend — the browser never decides who
 * the user is. Loading is shared so React StrictMode (which mounts effects
 * twice in development) cannot inject the script twice.
 */

export interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
}

interface GoogleButtonOptions {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "large" | "medium" | "small";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number;
}

interface GoogleIdentity {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
        ux_mode?: "popup" | "redirect";
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
      }) => void;
      renderButton: (parent: HTMLElement, options: GoogleButtonOptions) => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

const SCRIPT_ID = "google-identity-services";
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

let loading: Promise<void> | null = null;

/** Resolves once `window.google.accounts.id` is available. */
export function loadGoogleIdentity(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google sign-in needs a browser"));
  }
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    const onLoad = () => resolve();
    const onError = () => {
      loading = null;
      script.remove();
      reject(new Error("Google sign-in could not load"));
    };

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return loading;
}
