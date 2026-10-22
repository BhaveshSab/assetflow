/**
 * Holds the reason the API could not start.
 *
 * The environment is validated while `ConfigModule` boots. A hard failure
 * there used to kill the serverless function during *import*, which Vercel
 * reports as an opaque `500 FUNCTION_INVOCATION_FAILED` — with no hint about
 * the actual cause (a short `JWT_SECRET`, a missing `DATABASE_URL`, …).
 *
 * Instead the error is captured here: the process keeps running, every
 * request answers `503` with the real reason, and `GET /api/health` reports
 * it. The API therefore always explains itself instead of dying silently.
 */
let startupError: string | null = null;

export const startupStatus = {
  /** Record the reason the API is not usable. */
  setError(message: string): void {
    startupError = message;
  },

  /** The reason the API is not usable, or `null` when everything is fine. */
  getError(): string | null {
    return startupError;
  },

  /** Clear the error (used by the tests). */
  clearError(): void {
    startupError = null;
  },
};
