/**
 * Shared API client config for the whole frontend.
 *
 * The backend serves every route under /api. Locally that is port 4000 (see
 * backend/.env PORT=4000 and backend/API.md). In a deployed environment set
 * VITE_API_BASE_URL to the deployed API origin, e.g.
 *   VITE_API_BASE_URL=https://assetflow-api.vercel.app/api
 * Import BASE_URL from here instead of hardcoding a URL in each component.
 */

export const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

/** How long a request may take before it is aborted. */
const REQUEST_TIMEOUT_MS = 20_000;

/** The stored JWT — `null` when nobody is signed in. */
export function getToken(): string | null {
  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

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
    throw new Error(
      `Could not reach the AssetFlow API at ${BASE_URL}. Is the backend running?`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = Array.isArray(body?.message)
      ? body.message[0]
      : body?.message;
    throw new Error(message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
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
