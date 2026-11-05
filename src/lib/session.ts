/**
 * The stored session.
 *
 * It lives here — in its own module — so that both the auth client and the
 * API client can use it without importing each other in a circle:
 *
 *   api.ts  → session.ts  (clears the session when the API answers 401)
 *   auth.ts → session.ts  (saves it after a sign-in)
 */

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

export const SESSION_KEY = "session";
export const TOKEN_KEY = "token";

/** The stored JWT — `null` when nobody is signed in. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveSession(session: AuthResponse): void {
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

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}
