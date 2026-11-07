/**
 * /profile — the signed-in user's own account.
 *
 * Three things live here, and nothing else:
 *
 *   1. name and picture (PATCH /auth/me);
 *   2. password (POST /auth/change-password, which also signs out the other
 *      devices and hands back a replacement token);
 *   3. "sign out everywhere" (POST /auth/logout-everywhere).
 *
 * Role, department and e-mail are shown but not editable: those are an
 * administrator's decisions, and the API refuses to accept them from this
 * endpoint (the DTO whitelist rejects the extra keys).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Loader2,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiGet } from "@/lib/api";
import {
  apiChangePassword,
  apiLogoutEverywhere,
  apiUpdateProfile,
  type AuthUser,
} from "@/lib/auth";
import { clearSession } from "@/lib/session";
import { initialsOf } from "@/components/dashboard/TopHeader";

const MIN_PASSWORD = 8;

/** One small "this worked" strip; announced to screen readers. */
function Notice({ tone, children }: { tone: "ok" | "error"; children: string }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          : "rounded-md bg-success/10 px-3 py-2 text-sm text-success"
      }
    >
      {children}
    </p>
  );
}

export default function ProfilePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadError, setLoadError] = useState<string>();

  // profile form
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string>();
  const [profileError, setProfileError] = useState<string>();
  const [imageBroken, setImageBroken] = useState(false);

  // password form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();

  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<AuthUser>("/auth/me")
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setName(me.name);
        setAvatarUrl(me.avatarUrl ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Could not load your profile.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileError(undefined);
    setProfileNotice(undefined);

    if (name.trim().length < 2) {
      setProfileError("Your name needs at least two characters.");
      return;
    }
    const trimmedAvatar = avatarUrl.trim();
    if (trimmedAvatar && !/^https:\/\/\S+$/i.test(trimmedAvatar)) {
      // Same rule the API enforces: https only. `javascript:` and plain http
      // are refused before they leave the browser.
      setProfileError("The picture address must start with https://");
      return;
    }

    setSavingProfile(true);
    try {
      const updated = await apiUpdateProfile({
        name: name.trim(),
        avatarUrl: trimmedAvatar ? trimmedAvatar : null,
      });
      setUser(updated);
      setName(updated.name);
      setAvatarUrl(updated.avatarUrl ?? "");
      setImageBroken(false);
      setProfileNotice("Profile saved.");
    } catch (err) {
      setProfileError(
        err instanceof Error ? err.message : "Could not save your profile.",
      );
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordError(undefined);
    setPasswordNotice(undefined);

    if (newPassword.length < MIN_PASSWORD) {
      setPasswordError(`The new password needs ${MIN_PASSWORD} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("The two new passwords do not match.");
      return;
    }

    setSavingPassword(true);
    try {
      await apiChangePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordNotice(
        "Password changed. Every other device has been signed out.",
      );
    } catch (err) {
      setPasswordError(
        err instanceof Error ? err.message : "Could not change the password.",
      );
    } finally {
      setSavingPassword(false);
    }
  };

  const handleSignOutEverywhere = async () => {
    setSigningOut(true);
    try {
      await apiLogoutEverywhere();
    } catch {
      // The token may already be dead — either way the local session goes.
      clearSession();
    } finally {
      // A full navigation (not a router push) so every in-memory cache in the
      // app is thrown away with the session.
      window.location.assign("/signin");
    }
  };

  if (loadError) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8">
          <h1 className="text-xl font-bold text-ink">Profile unavailable</h1>
          <p className="mt-2 text-sm text-ink-muted" role="alert">
            {loadError}
          </p>
          <Link
            to="/signin"
            className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
          >
            Sign in again
          </Link>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main
        className="flex min-h-dvh items-center justify-center gap-2 bg-canvas text-sm text-ink-muted"
        role="status"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your profile…
      </main>
    );
  }

  const initials = initialsOf(user.name);
  const showImage = Boolean(user.avatarUrl) && !imageBroken;

  return (
    <main className="min-h-dvh bg-canvas px-4 py-8 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto w-full max-w-2xl space-y-6"
      >
        <div className="flex items-center justify-between">
          <Link
            to="/Dashboard"
            className="inline-flex items-center gap-2 text-sm font-medium text-ink-muted hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to the dashboard
          </Link>
        </div>

        {/* ── identity ─────────────────────────────────────────── */}
        <section className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-info text-lg font-semibold text-white">
              {showImage ? (
                <img
                  src={user.avatarUrl ?? ""}
                  alt=""
                  width={56}
                  height={56}
                  referrerPolicy="no-referrer"
                  className="h-14 w-14 object-cover"
                  onError={() => setImageBroken(true)}
                />
              ) : (
                <span aria-hidden="true">{initials}</span>
              )}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold text-ink">
                {user.name}
              </h1>
              <p className="truncate text-sm text-ink-muted">{user.email}</p>
              <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                {user.role.replace("_", " ")}
              </p>
            </div>
          </div>

          <form onSubmit={handleProfile} className="mt-6 space-y-4" noValidate>
            <Field label="Name" required htmlFor="profile-name">
              <Input
                id="profile-name"
                type="text"
                autoComplete="name"
                className="h-11"
                value={name}
                disabled={savingProfile}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field
              label="Picture address"
              htmlFor="profile-avatar"
              hint="An https:// link to an image. Leave it empty to use your initials."
            >
              <Input
                id="profile-avatar"
                type="url"
                inputMode="url"
                placeholder="https://images.example.com/me.png"
                className="h-11"
                value={avatarUrl}
                disabled={savingProfile}
                onChange={(e) => {
                  setAvatarUrl(e.target.value);
                  setImageBroken(false);
                }}
              />
            </Field>

            {profileError && <Notice tone="error">{profileError}</Notice>}
            {profileNotice && <Notice tone="ok">{profileNotice}</Notice>}

            <Button
              type="submit"
              className="h-11 w-full sm:w-auto"
              disabled={savingProfile}
            >
              {savingProfile ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <UserRound className="h-4 w-4" aria-hidden="true" />
              )}
              {savingProfile ? "Saving…" : "Save changes"}
            </Button>
          </form>
        </section>

        {/* ── password ─────────────────────────────────────────── */}
        <section className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
          <h2 className="text-lg font-semibold text-ink">Change password</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Changing your password signs out every other device, including this
            one&apos;s other tabs.
          </p>

          <form onSubmit={handlePassword} className="mt-5 space-y-4" noValidate>
            <Field label="Current password" required htmlFor="profile-current">
              <Input
                id="profile-current"
                type="password"
                autoComplete="current-password"
                className="h-11"
                value={currentPassword}
                disabled={savingPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </Field>

            <Field
              label="New password"
              required
              htmlFor="profile-new"
              hint={`At least ${MIN_PASSWORD} characters.`}
            >
              <Input
                id="profile-new"
                type="password"
                autoComplete="new-password"
                className="h-11"
                value={newPassword}
                disabled={savingPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>

            <Field
              label="Confirm new password"
              required
              htmlFor="profile-confirm"
            >
              <Input
                id="profile-confirm"
                type="password"
                autoComplete="new-password"
                className="h-11"
                value={confirmPassword}
                disabled={savingPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </Field>

            {passwordError && <Notice tone="error">{passwordError}</Notice>}
            {passwordNotice && <Notice tone="ok">{passwordNotice}</Notice>}

            <Button
              type="submit"
              className="h-11 w-full sm:w-auto"
              disabled={savingPassword}
            >
              {savingPassword && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {savingPassword ? "Saving…" : "Change password"}
            </Button>
          </form>
        </section>

        {/* ── sessions ─────────────────────────────────────────── */}
        <section className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
          <h2 className="text-lg font-semibold text-ink">Sessions</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Signing out everywhere invalidates every token issued so far,
            including the one this browser is using.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-5 h-11"
            disabled={signingOut}
            onClick={handleSignOutEverywhere}
          >
            {signingOut ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogOut className="h-4 w-4" aria-hidden="true" />
            )}
            Sign out everywhere
          </Button>
        </section>
      </motion.div>
    </main>
  );
}
