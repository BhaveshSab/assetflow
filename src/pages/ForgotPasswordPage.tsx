/**
 * /forgot-password — "I cannot sign in, send me a link".
 *
 * The page has one job and one rule: whatever the answer, the visitor learns
 * the same thing. The API answers `202` for every address, so this screen
 * shows the same confirmation for every address — a "no account with that
 * e-mail" message would turn the form into a tool for finding out who works
 * here.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2, MailCheck, Send } from "lucide-react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiForgotPassword } from "@/lib/auth";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);
    try {
      await apiForgotPassword(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      // A network failure is *not* an account-existence signal, so it is the
      // only kind of failure this page reports.
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach the server. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  if (sentTo) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-xl"
      >
        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-info/15 text-info">
          <MailCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          Check your inbox
        </h1>
        <p className="mt-2 text-sm text-ink-muted" role="status">
          If an account exists for <strong className="text-ink">{sentTo}</strong>
          , a reset link is on its way. The link works once and expires in 30
          minutes.
        </p>

        <div className="mt-6 space-y-3">
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            onClick={() => {
              // A real second attempt: the previous link stops working and a
              // new one is issued.
              setSentTo(null);
            }}
          >
            Use a different address
          </Button>
          <Link
            to="/signin"
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to sign in
          </Link>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-xl"
    >
      <h1 className="text-2xl font-bold tracking-tight text-ink">
        Forgot your password?
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        Enter the address you signed up with and we will send you a link to
        choose a new password.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <Field label="Email" required error={error} htmlFor="forgot-email">
          <Input
            id="forgot-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            className="h-11"
            value={email}
            disabled={loading}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Button type="submit" className="h-11 w-full" disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
          {loading ? "Sending…" : "Send reset link"}
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
