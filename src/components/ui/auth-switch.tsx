import * as React from "react";
import {
  Check,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
  User as UserIcon,
} from "lucide-react";
import { motion } from "framer-motion";

import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AuthMode = "signin" | "signup";

/** Google "G" glyph (lucide ships no brand Google icon). */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

export interface AuthSwitchSubmitEvent {
  mode: AuthMode;
  email: string;
  password: string;
  name?: string;
}

export interface AuthSwitchProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSubmit"> {
  /** Which form is shown first. @default "signup" */
  defaultMode?: AuthMode;
  /** Control the mode externally. If omitted the component manages its own state. */
  mode?: AuthMode;
  onModeChange?: (mode: AuthMode) => void;
  /** Called when either form is submitted and basic validation passes. */
  onSubmit?: (data: AuthSwitchSubmitEvent) => void | Promise<void>;
  /** Brand / product name shown on the purple panel. */
  brandName?: string;
  /** Custom logo element. Replaces the default mark. */
  brand?: React.ReactNode;
  /** Disable inputs + show a spinner on the submit button (e.g. during a request). */
  loading?: boolean;
  /** Error message rendered under the form (e.g. "Invalid credentials"). */
  error?: string;
  /** Route path for the OTHER mode. Renders the side-panel CTA + footer link as <Link>. */
  otherTo?: string;
  /**
   * Optional Google sign-in control (the real Google Identity Services
   * button). When omitted, a disabled placeholder is shown — Google is an
   * optional integration, not a dead button.
   */
  googleSlot?: React.ReactNode;
}

const OTHER_MODE: Record<AuthMode, AuthMode> = {
  signin: "signup",
  signup: "signin",
};

/*
 * The left panel is product context, not a second call to action.
 *
 * It used to carry a "NEW HERE?" badge, a headline selling sign-up and its
 * own "Sign Up" button — on top of the footer link to the same page. Three
 * invitations to do the same thing, one of them pitched at new users while
 * the form next to it was for returning ones. The copy now describes the
 * product and stays true in both modes, and the footer link is the only way
 * to switch screens.
 */
const PANEL_COPY = {
  signin: {
    title: "Pick up where you left off.",
    subtitle:
      "Sign in to manage assets, allocations, bookings and maintenance from one workspace.",
  },
  signup: {
    title: "Set up your workspace.",
    subtitle:
      "Create an account to bring your organisation's assets, allocations and audits into one place.",
  },
} as const;

/**
 * What the product actually does.
 *
 * This replaced a five-star quote attributed to a customer who does not exist.
 * A testimonial nobody said is the one piece of copy on a sign-in page that is
 * *provably* false, and it buys nothing: these three lines are true of every
 * commit in this repository and can be checked in the code.
 */
const CAPABILITIES = [
  "Every asset, allocation, booking and audit in one place",
  "Admin, manager, department-head and employee roles",
  "Every change recorded in an append-only activity log",
] as const;

function PasswordInput({
  id,
  autoComplete,
  disabled,
  value,
  onChange,
}: {
  id: string;
  autoComplete: string;
  disabled?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        placeholder="••••••••"
        disabled={disabled}
        value={value}
        onChange={onChange}
        className="h-11 bg-surface pr-11"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        tabIndex={-1}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function FieldIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
      {children}
    </span>
  );
}

const AuthSwitch = React.forwardRef<HTMLDivElement, AuthSwitchProps>(
  (
    {
      className,
      defaultMode = "signup",
      mode: modeProp,
      onModeChange,
      onSubmit,
      brandName = "AssetFlow",
      brand,
      loading = false,
      error,
      otherTo,
      googleSlot
    },
    ref
  ) => {
    const isControlled = modeProp !== undefined;
    const [internalMode, setInternalMode] = React.useState<AuthMode>(defaultMode);
    const mode = isControlled ? modeProp : internalMode;
    const isSignup = mode === "signup";

    const setMode = React.useCallback(
      (next: AuthMode) => {
        if (!isControlled) setInternalMode(next);
        onModeChange?.(next);
      },
      [isControlled, onModeChange]
    );

    // shared field state
    const [name, setName] = React.useState("");
    const [email, setEmail] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [confirm, setConfirm] = React.useState("");
    const [agree, setAgree] = React.useState(false);
    const [localError, setLocalError] = React.useState<string | null>(null);

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      setLocalError(null);

      if (!emailValid) return setLocalError("Please enter a valid email address.");
      // The API rejects anything shorter than 8 (see ResetPasswordDto /
      // ChangePasswordDto). Checking 6 here meant a 6–7 character password
      // passed this form and came back as a server error.
      if (password.length < 8)
        return setLocalError("Password must be at least 8 characters.");

      if (isSignup) {
        if (!name.trim()) return setLocalError("Please enter your name.");
        if (confirm !== password) return setLocalError("Passwords do not match.");
        if (!agree) return setLocalError("Please accept the Terms to continue.");
      }

      void onSubmit?.({
        mode,
        email,
        password,
        name: isSignup ? name.trim() : undefined,
      });
    };

    const activeError = localError ?? error;
    const copy = PANEL_COPY[mode];

    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 350, damping: 28 }}
        className={cn(
          "mx-auto w-full max-w-[1120px] overflow-hidden rounded-2xl bg-card shadow-xl shadow-primary/10 ring-1 ring-border md:grid md:grid-cols-2",
          className
        )}
      >
        {/* LEFT: brand panel — context only, no second CTA */}
        <aside className="relative hidden flex-col overflow-hidden bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-700 p-10 text-white md:flex">
          {/* decorative glow */}
          <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-fuchsia-400/20 blur-3xl" />

          <div className="relative flex items-center gap-2.5">
            {brand ?? (
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/25 backdrop-blur">
                <Sparkles className="h-5 w-5" />
              </span>
            )}
            <span className="text-lg font-semibold tracking-tight">{brandName}</span>
          </div>

          {/* The headline sits right under the logo. The panel used to push
              it to the bottom, leaving a large empty run of purple between
              the two. */}
          <div className="relative mt-12 space-y-4">
            <h2 className="text-3xl font-bold leading-tight xl:text-4xl">
              {copy.title}
            </h2>
            <p className="max-w-sm text-sm leading-relaxed text-white/85">
              {copy.subtitle}
            </p>
          </div>

          {/* what the product does (checked against the code, not invented) */}
          <ul className="relative mt-auto space-y-3 rounded-xl bg-black/20 p-5 text-sm leading-relaxed text-white ring-1 ring-white/25 backdrop-blur">
            {CAPABILITIES.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-200" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </aside>

        {/* RIGHT: form panel */}
        <section className="flex flex-col justify-center p-7 sm:p-10">
          {/* mobile brand row (left panel is hidden on small screens) */}
          <div className="mb-8 flex items-center gap-2.5 md:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight">{brandName}</span>
          </div>

          <div className="space-y-1.5">
            <motion.h1
              key={`title-${mode}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {isSignup ? "Create account" : "Sign in"}
            </motion.h1>
            <motion.p
              key={`sub-${mode}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.05 }}
              className="text-sm text-ink-soft"
            >
              {isSignup
                ? "Create an account to start managing your organisation's assets."
                : "Welcome back! Please enter your details."}
            </motion.p>
          </div>

          {/* social — only what the server can actually do.
              Google renders the real Google Identity Services button when the
              backend has a client id, and an honestly-disabled placeholder
              when it does not. The GitHub button that used to sit here is
              gone: the API has no GitHub OAuth route, so it could only ever
              do nothing. */}
          <div className="mt-6 grid grid-cols-1 gap-3">
            {googleSlot ?? (
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled
                title="Google sign-in is not configured on this server"
              >
                <GoogleIcon className="h-4 w-4" />
                Google
              </Button>
            )}
          </div>

          <div className="my-6 flex items-center gap-3 text-xs font-medium text-ink-soft">
            <span className="h-px flex-1 bg-border" />
            {isSignup ? "or sign up with email" : "or sign in with email"}
            <span className="h-px flex-1 bg-border" />
          </div>

          {/* form */}
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {isSignup && (
              <div className="space-y-1.5">
                <Label htmlFor="auth-name">Full name</Label>
                <div className="relative">
                  <FieldIcon>
                    <UserIcon className="h-4 w-4" />
                  </FieldIcon>
                  <Input
                    id="auth-name"
                    type="text"
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    disabled={loading}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-11 bg-surface pl-10"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="auth-email">Email</Label>
              <div className="relative">
                <FieldIcon>
                  <Mail className="h-4 w-4" />
                </FieldIcon>
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  disabled={loading}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 bg-surface pl-10"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="auth-password">Password</Label>
                {!isSignup && (
                  <Link
                    to="/forgot-password"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <PasswordInput
                id="auth-password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                disabled={loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {isSignup && (
              <div className="space-y-1.5">
                <Label htmlFor="auth-confirm">Confirm password</Label>
                <PasswordInput
                  id="auth-confirm"
                  autoComplete="new-password"
                  disabled={loading}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            )}

            {isSignup ? (
              <label className="flex items-start gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={agree}
                  onChange={(e) => setAgree(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                />
                <span>
                  I understand that the actions I take here are recorded in the
                  activity log.
                </span>
              </label>
            ) : null}

            {activeError && (
              <p
                role="alert"
                className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {activeError}
              </p>
            )}

            <Button type="submit" className="h-11 w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading
                ? isSignup
                  ? "Creating account…"
                  : "Signing in…"
                :      isSignup
                ? "Create account"
                : "Sign in"}
            </Button>
          </form>

          {/* footer switch (mirrors the side panel CTA) */}
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
            {otherTo ? (
              <Link
                to={otherTo}
                className={cn(
                  buttonVariants({ variant: "link" }),
                  "h-auto p-0 text-primary"
                )}
              >
                {isSignup ? "Sign in" : "Sign up"}
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setMode(OTHER_MODE[mode])}
                className={cn(
                  buttonVariants({ variant: "link" }),
                  "h-auto p-0 text-primary"
                )}
              >
                {isSignup ? "Sign in" : "Sign up"}
              </button>
            )}
          </p>

          <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-ink-muted">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            SSL secured connection
          </p>
        </section>
      </motion.div>
    );
  }
);
AuthSwitch.displayName = "AuthSwitch";

export { AuthSwitch as default, AuthSwitch };
export type { AuthMode as AuthSwitchMode };
