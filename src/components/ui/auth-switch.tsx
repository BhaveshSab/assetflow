import * as React from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Github,
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
}

const OTHER_MODE: Record<AuthMode, AuthMode> = {
  signin: "signup",
  signup: "signin",
};

// Copy that flips based on which form is active. When you're on one form,
// the opposite panel invites you to switch — this is the "convertible" hook.
const PANEL_COPY = {
  signin: {
    badge: "New here?",
    title: "Welcome to the future of asset management.",
    subtitle:
      "Sign up and discover a great amount of new opportunities to grow your portfolio.",
    cta: "Sign Up",
    quote: {
      text: "AssetFlow completely transformed how our team tracks and manages every asset we own. It's intuitive, fast, and beautiful.",
      author: "Alicia Mercer",
      role: "COO, Northwind Capital",
    },
  },
  signup: {
    badge: "One of us?",
    title: "Welcome Back!",
    subtitle:
      "Enter your details and start your journey with us. Pick up right where you left off.",
    cta: "Sign In",
    quote: {
      text: "AssetFlow completely transformed how our team tracks and manages every asset we own. It's intuitive, fast, and beautiful.",
      author: "Alicia Mercer",
      role: "COO, Northwind Capital",
    },
  },
} as const;

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
        className="h-11 pr-11"
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
      otherTo
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
      if (password.length < 6)
        return setLocalError("Password must be at least 6 characters.");

      if (isSignup) {
        if (!name.trim()) return setLocalError("Please enter your name.");
        if (confirm !== password) return setLocalError("Passwords do not match.");
        if (!agree) return setLocalError("Please accept the Terms to continue.");
      }

      onSubmit?.({
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
          "w-full max-w-5xl overflow-hidden rounded-2xl bg-card shadow-xl shadow-primary/10 ring-1 ring-border md:grid md:grid-cols-2",
          className
        )}
      >
        {/* LEFT: purple brand / toggle panel */}
        <aside className="relative hidden flex-col justify-between bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-700 p-10 text-white md:flex">
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

          <div className="relative space-y-6">
            <span className="inline-flex items-center rounded-full bg-white/15 px-3 py-1 text-xs font-medium uppercase tracking-wider ring-1 ring-white/25">
              {copy.badge}
            </span>
            <h2 className="text-3xl font-bold leading-tight xl:text-4xl">
              {copy.title}
            </h2>
            <p className="max-w-sm text-sm leading-relaxed text-white/80">
              {copy.subtitle}
            </p>

            {otherTo ? (
              <Link
                to={otherTo}
                className="group inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-purple-700 shadow-lg transition-all hover:shadow-xl hover:active:scale-[0.98]"
              >
                {copy.cta}
                <ArrowLeft className="h-4 w-4 rotate-180 transition-transform group-hover:translate-x-1" />
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setMode(OTHER_MODE[mode])}
                className="group inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-purple-700 shadow-lg transition-all hover:shadow-xl hover:active:scale-[0.98]"
              >
                {copy.cta}
                <ArrowLeft className="h-4 w-4 rotate-180 transition-transform group-hover:translate-x-1" />
              </button>
            )}
          </div>

          {/* testimonial */}
          <figure className="relative space-y-3 rounded-xl bg-white/10 p-5 ring-1 ring-white/15 backdrop-blur">
            <div className="flex gap-0.5 text-amber-300" aria-label="5 out of 5 stars">
              {Array.from({ length: 5 }).map((_, i) => (
                <svg key={i} viewBox="0 0 20 20" className="h-4 w-4 fill-current">
                  <path d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 15l-5.2 2.6 1-5.8L1.5 7.7l5.9-.9L10 1.5z" />
                </svg>
              ))}
            </div>
            <blockquote className="text-sm leading-relaxed text-white/90">
              “{copy.quote.text}”
            </blockquote>
            <figcaption className="text-xs text-white/70">
              <span className="font-semibold text-white">{copy.quote.author}</span>{" "}
              · {copy.quote.role}
            </figcaption>
          </figure>
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
              className="text-sm text-muted-foreground"
            >
              {isSignup
                ? "Start your free trial. No credit card required."
                : "Welcome back! Please enter your details."}
            </motion.p>
          </div>

          {/* social */}
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" className="h-11" disabled={loading}>
              <GoogleIcon className="h-4 w-4" />
              Google
            </Button>
            <Button type="button" variant="outline" className="h-11" disabled={loading}>
              <Github className="h-4 w-4" />
              GitHub
            </Button>
          </div>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
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
                    className="h-11 pl-10"
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
                  className="h-11 pl-10"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="auth-password">Password</Label>
                {!isSignup && (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Forgot password?
                  </button>
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
                  I agree to the{" "}
                  <span className="font-medium text-primary hover:underline cursor-pointer">
                    Terms
                  </span>{" "}
                  and{" "}
                  <span className="font-medium text-primary hover:underline cursor-pointer">
                    Privacy Policy
                  </span>
                  .
                </span>
              </label>
            ) : (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                Remember me
              </label>
            )}

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

          <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Secured with 256-bit encryption
          </p>
        </section>
      </motion.div>
    );
  }
);
AuthSwitch.displayName = "AuthSwitch";

export { AuthSwitch as default, AuthSwitch };
export type { AuthMode as AuthSwitchMode };
