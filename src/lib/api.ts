/**
 * Shared API client config for the whole frontend.
 *
 * The backend serves every route under /api. Locally that is port 4000 (see
 * backend/.env PORT=4000 and backend/API.md). In a deployed environment set
 * VITE_API_BASE_URL to the deployed API origin, e.g.
 *   VITE_API_BASE_URL=https://assetflow-api.vercel.app/api
 * Import BASE_URL from here instead of hardcoding a URL in each component.
 */

import { clearSession, getToken } from "@/lib/session";

export const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

/** How long a request may take before it is aborted. */
const REQUEST_TIMEOUT_MS = 20_000;

/** The stored JWT — `null` when nobody is signed in. */
export { getToken } from "@/lib/session";

/**
 * JSON headers with the JWT attached.
 *
 * The Authorization header is *omitted* when there is no token — sending
 * "Bearer " (an empty credential) would turn a public request into a 401.
 */
export const authHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

/**
 * What happens when the API answers "Unauthorized".
 *
 * Without this the app kept showing the last data it had and every request
 * failed with a bare "Unauthorized" — the user had no idea that they had to
 * sign in again. The page they were on is remembered so they land back on it
 * after signing in.
 */
export function handleUnauthorized(): void {
  clearSession();

  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/signin" || pathname === "/signup") return; // no loop

  const next = encodeURIComponent(`${pathname}${search}`);
  const target = `/signin?next=${next}`;
  try {
    window.location.assign(target);
  } catch {
    window.location.href = target;
  }
}

/** fetch + timeout + JSON error normalisation, shared by GET and POST/PATCH. */
async function request<T>(
  path: string,
  init: RequestInit & { method: string },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new Error("The request timed out. Please try again.");
    }
    // A CORS refusal and an API that is simply down both surface here as a
    // bare "Failed to fetch" — the browser hides everything about the reply.
    // Naming both possibilities turns a dead sign-in button into something the
    // person reading the screen can act on.
    const page =
      typeof window === "undefined" ? "this page" : window.location.origin;
    throw new Error(
      `Could not reach the AssetFlow API at ${BASE_URL}. ` +
        `It may be offline, or it may not allow ${page} to call it.`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 401 = the token expired, was revoked, or the account was deactivated
    // while the tab was open. Everything the app shows after that is stale,
    // so the session is dropped and the user is sent back to the sign-in page
    // with the page they were on kept in the URL.
    if (res.status === 401) handleUnauthorized();

    const body = await res.json().catch(() => ({}));
    const message = Array.isArray(body?.message)
      ? body.message[0]
      : body?.message;
    throw new Error(
      message ??
        (res.status === 401
          ? "Your session has expired. Please sign in again."
          : `Request failed (${res.status})`),
    );
  }
  // Await first, then narrow — `as Promise<T>` only silenced the compiler
  // without ever checking the shape of the answer.
  return (await res.json()) as T;
}

/** Convenience GET that throws on non-2xx. */
export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET", headers: authHeaders() });
}

/** Convenience POST/PATCH/DELETE that throws on non-2xx. */
export async function apiSend<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Normalize { items, total } list responses into a plain array. */
export function unwrapList<T>(data: { items?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
}
