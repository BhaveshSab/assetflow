/**
 * Auth client — talks to the real NestJS backend.
 *
 * - POST  /auth/signup  { name, email, password }  → { token, user }
 * - POST  /auth/login   { email, password }        → { token, user }
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
import { BASE_URL, getToken } from "@/lib/api";

export type UserRole =
  | "ADMIN"
  | "ASSET_MANAGER"
  | "DEPARTMENT_HEAD"
  | "EMPLOYEE";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: string;
  departmentId: string | null;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface AuthPayload {
  email: string;
  password: string;
  name?: string;
}

const SESSION_KEY = "session";
const TOKEN_KEY = "token";

export function saveSession(session: AuthResponse) {
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getSession(): AuthResponse | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthResponse) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
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
