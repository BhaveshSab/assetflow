/**
 * /reset-password?token=… — the page the e-mailed link opens.
 *
 * The token is spent by the API, not here: this screen only collects the new
 * password and shows whatever the server decides. A missing, expired, used or
 * forged token all produce the same message ("invalid or has expired"), which
 * is exactly what the API says — there is nothing to gain from being more
 * specific with someone who does not hold a valid link.
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiResetPassword } from "@/lib/auth";

const MIN_PASSWORD = 8;

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);

    if (password.length < MIN_PASSWORD) {
      setError(`Your password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      await apiResetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not reset the password. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  // No token at all: the visitor opened /reset-password by hand, or the link
  // lost its query string on the way. Say so instead of showing a form that
  // cannot succeed.
  if (!token) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-xl"
      >
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          This link is incomplete
        </h1>
        <p className="mt-2 text-sm text-ink-muted" role="alert">
          The reset link needs its token. Open the link from the e-mail again,
          or request a new one.
        </p>
        <Link
          to="/forgot-password"
          className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
        >
          Request a new link
        </Link>
      </motion.div>
    );
  }

  if (done) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-xl"
      >
        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          Password changed
        </h1>
        <p className="mt-2 text-sm text-ink-muted" role="status">
          Every other device has been signed out. Sign in with your new
          password.
        </p>
        <Link
          to="/signin"
          className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
        >
          Go to sign in
        </Link>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-xl"
    >
      <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary">
        <KeyRound className="h-5 w-5" aria-hidden="true" />
      </span>
      <h1 className="text-2xl font-bold tracking-tight text-ink">
        Choose a new password
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        At least {MIN_PASSWORD} characters. Changing it signs out every other
        device.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <Field
          label="New password"
          required
          htmlFor="reset-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
        >
          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            className="h-11"
            value={password}
            disabled={loading}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Field
          label="Confirm password"
          required
          htmlFor="reset-confirm"
          error={error}
        >
          <Input
            id="reset-confirm"
            type="password"
            autoComplete="new-password"
            className="h-11"
            value={confirm}
            disabled={loading}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>

        <Button type="submit" className="h-11 w-full" disabled={loading}>
          {loading && (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          {loading ? "Saving…" : "Set new password"}
        </Button>
      </form>

      <Link
        to="/signin"
        className="mt-6 flex items-center justify-center gap-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to sign in
      </Link>
    </motion.div>
  );
}
