/**
 * Shared API client config for the whole frontend.
 *
 * The backend serves every route under /api and runs on port 4000 (see
 * backend/.env PORT=4000 and backend/API.md). Import BASE_URL from here
 * instead of hardcoding "http://localhost:5000/api" in each component.
 */

export const BASE_URL = "http://localhost:4000/api";

/** JSON headers with the JWT attached (when a token exists). */
export const authHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
});

/** Convenience GET that throws on non-2xx. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** Convenience POST/PATCH that throws on non-2xx. */
export async function apiSend<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message ?? `Request failed (${res.status})`);
  }
  // Some endpoints (e.g. POST /notifications/read-all) return 201 with an
  // empty body — tolerate that instead of choking on res.json().
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as Promise<T>;
}

/** Normalize { items, total } list responses into a plain array. */
export function unwrapList<T>(data: { items?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
}
