/**
 * Vercel rewrites every request to `/api/index.js` (see `vercel.json`).
 *
 * Depending on the platform version the function is then invoked with the
 * *destination* path instead of the original one — the Express router would
 * look for `/api/index.js` and answer 404. Stripping the function's own file
 * name restores the original URL (`/api/assets`).
 *
 * The API itself is mounted under `/api` (the global prefix), so the function
 * file `/api/index.js` maps onto the API root `/api`.
 */

/** The path of this function inside the deployment. */
export const FUNCTION_PATH = '/api/index.js';

/** The mount point of the API (Nest's global prefix). */
export const API_ROOT = '/api';

/**
 * Removes the function's own file name from an incoming URL.
 *
 * - `/api/index.js`        → `/api`
 * - `/api/index.js/assets` → `/api/assets`
 * - `/api/assets`          → unchanged (the normal case)
 *
 * The query string is preserved.
 */
export function normalizeUrl(url?: string): string | undefined {
  if (!url) return url;

  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? '' : url.slice(queryStart);

  if (path === FUNCTION_PATH) return `${API_ROOT}${query}`;

  if (path.startsWith(`${FUNCTION_PATH}/`)) {
    return `${API_ROOT}${path.slice(FUNCTION_PATH.length)}${query}`;
  }

  return url;
}
