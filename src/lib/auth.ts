/**
 * Auth client — talks to the real NestJS backend.
 *
 * - POST  /auth/signup  { name, email, password }  → { token, user }
 * - POST  /auth/login   { email, password }        → { token, user }
 * - GET   /auth/config                            → { googleClientId }
 * - POST  /auth/google  { credential }            → { token, user }
 * - GET   /auth/me                                → user (refreshes role)
 *
 * The JWT is persisted under `localStorage.token` (all components read it) and
 * the full session under `localStorage.session`.
 *
 * NOTE: a token in localStorage is readable by any script running on the page.
 * The API therefore never stores anything sensitive in the token itself and
 * every request is authorised server-side against the *current* user record
 * (role changes and deactivations take effect immediately).
 */
import { BASE_URL, apiGet, apiSend } from "@/lib/api";
import {
  clearSession,
  getSession,
  getToken,
  saveSession,
  type AuthResponse,
  type AuthUser,
} from "@/lib/session";

export type { AuthResponse, AuthUser, UserRole } from "@/lib/session";
export { clearSession, getSession, saveSession } from "@/lib/session";

export interface AuthPayload {
  email: string;
  password: string;
  name?: string;
}

export interface AuthConfig {
  /** The public Google OAuth client id, or null when Google is not configured. */
  googleClientId: string | null;
}

async function requestAuth<T>(
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data?.message === "string"
        ? data.message
        : Array.isArray(data?.message)
          ? data.message[0]
          : "Authentication failed. Please try again.",
    );
  }
  return data as T;
}

export async function apiSignIn(payload: AuthPayload): Promise<AuthResponse> {
  const session = await requestAuth<AuthResponse>("/auth/login", {
    email: payload.email,
    password: payload.password,
  });
  saveSession(session);
  return session;
}

export async function apiSignUp(payload: AuthPayload): Promise<AuthResponse> {
  const session = await requestAuth<AuthResponse>("/auth/signup", {
    name: payload.name,
    email: payload.email,
    password: payload.password,
  });
  saveSession(session);
  return session;
}

/**
 * GET /auth/config — the public Google client id the sign-in button needs.
 * A failure is not fatal: the page simply keeps Google hidden.
 */
export async function apiAuthConfig(): Promise<AuthConfig> {
  const res = await fetch(`${BASE_URL}/auth/config`);
  if (!res.ok) {
    throw new Error(`Could not load the sign-in configuration (${res.status})`);
  }
  return (await res.json()) as AuthConfig;
}

/** Exchange a Google ID token for an AssetFlow session. */
export async function apiGoogleSignIn(
  credential: string,
): Promise<AuthResponse> {
  const session = await requestAuth<AuthResponse>("/auth/google", {
    credential,
  });
  saveSession(session);
  return session;
}

/** GET /auth/me — refreshes the session's user (role) from the backend. */
export async function getMe(): Promise<AuthUser> {
  const token = getToken();
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("Session expired");
  }
  const user = (await res.json()) as AuthUser;
  const session = getSession();
  if (session) saveSession({ ...session, user });
  return user;
}

// ---------------------------------------------------------------------------
// Self-service account management
//
// These four calls are what the "Forgot password?", "Reset password" and
// "Profile" screens use. They talk to the same API as everything else, so a
// 401 is handled (and the session dropped) by the shared client in lib/api.
// ---------------------------------------------------------------------------

/** POST /auth/forgot-password — always succeeds, never says if the address exists. */
export async function apiForgotPassword(email: string): Promise<string> {
  const res = await apiSend<{ message: string }>("/auth/forgot-password", "POST", {
    email,
  });
  return res.message;
}

/** POST /auth/reset-password — spends the token from the e-mail, once. */
export async function apiResetPassword(
  token: string,
  password: string,
): Promise<string> {
  const res = await apiSend<{ message: string }>("/auth/reset-password", "POST", {
    token,
    password,
  });
  return res.message;
}

/**
 * POST /auth/change-password — returns the replacement token.
 *
 * The server bumps the account's token version, which invalidates every token
 * minted before this moment (that is how "other devices are signed out"
 * works). The caller's own token is one of those, so the new one has to be
 * stored immediately or the very next request would 401.
 */
export async function apiChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthUser> {
  const { token } = await apiSend<{ token: string }>(
    "/auth/change-password",
    "POST",
    { currentPassword, newPassword },
  );

  const user = await apiGet<AuthUser>("/auth/me");
  saveSession({ token, user });
  return user;
}

/** PATCH /auth/me — the signed-in user's own name and picture. */
export async function apiUpdateProfile(input: {
  name?: string;
  avatarUrl?: string | null;
}): Promise<AuthUser> {
  const user = await apiSend<AuthUser>("/auth/me", "PATCH", input);

  // Keep the stored session in step so the header avatar and the name in the
  // sidebar update without a reload.
  const session = getSession();
  const token = getToken();
  if (session && token) saveSession({ token, user });
  return user;
}

/** POST /auth/logout-everywhere — kills every token, then forgets this one. */
export async function apiLogoutEverywhere(): Promise<void> {
  await apiSend<{ message: string }>("/auth/logout-everywhere", "POST");
  clearSession();
}
