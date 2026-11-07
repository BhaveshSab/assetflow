/**
 * The browser-origin allowlist, in one place.
 *
 * A cross-origin call from the SPA only reaches the API when the reply carries
 * `Access-Control-Allow-Origin` naming the page's exact origin. Without it the
 * browser hides the response and shows
 *
 *     Access to fetch at '…/api/auth/login' from origin '…' has been blocked
 *     by CORS policy: No 'Access-Control-Allow-Origin' header is present
 *
 * — the operator sees a network error and never the message the API sent. Two
 * rules keep that from being a dead end:
 *
 *  - the configured value is normalised. `https://app.example.com/` (trailing
 *    slash, stray spaces) can never match `https://app.example.com`, which is
 *    all a browser ever sends — so a correct-looking value would silently
 *    block every request;
 *  - a refused origin is logged next to the list that was in effect, so the
 *    deployment's own runtime log answers "what does the function actually
 *    think `CORS_ORIGINS` is?" without a redeploy.
 */

/** Used only when `CORS_ORIGINS` is unset — the two Vite dev ports. */
export const LOCAL_DEV_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://localhost:5174',
];

/**
 * Split `CORS_ORIGINS` on commas and make every entry comparable.
 *
 * Origins are compared as opaque strings, so the bare scheme+host+port form is
 * the only one that can match what the browser sends: no trailing slash, no
 * whitespace, no duplicates.
 */
export function parseOrigins(
  raw: string | undefined = process.env.CORS_ORIGINS,
): string[] {
  const value = (raw ?? '').trim() || LOCAL_DEV_ORIGINS.join(',');
  const origins = [
    ...new Set(
      value
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ];
  // A value made only of commas ("https://a.example,") must not turn into an
  // empty allowlist that blocks every browser — fall back to the defaults,
  // which the boot log then prints, so the mistake is visible.
  return origins.length > 0 ? origins : [...LOCAL_DEV_ORIGINS];
}

/**
 * Whether a request from `origin` may read the response.
 *
 * A missing `origin` is not a cross-origin browser call at all — same-origin
 * requests, `curl`, health probes and server-to-server traffic do not send it,
 * and CORS has nothing to say about them.
 */
export function isOriginAllowed(
  origin: string | undefined,
  origins: string[],
): boolean {
  if (!origin) return true;
  const candidate = origin.trim().replace(/\/+$/, '');
  return origins.includes('*') || origins.includes(candidate);
}

/**
 * Headers for a response the application writes itself, outside the Nest
 * pipeline (the serverless entrypoint's "the API could not start" answer).
 *
 * Without them a boot failure is indistinguishable from a CORS block in the
 * browser: both look like "no 'Access-Control-Allow-Origin' header". With
 * them, the SPA reads the real 503 body and can show the reason.
 */
export function corsHeadersFor(
  origin: string | undefined,
  origins: string[],
): Record<string, string> {
  if (!origin) return {};
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (isOriginAllowed(origin, origins)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}
