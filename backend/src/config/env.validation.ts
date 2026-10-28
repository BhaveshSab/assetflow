/**
 * Environment validation.
 *
 * Runs once, when `ConfigModule` boots (after `.env` has been loaded), so a
 * misconfigured deployment fails *at startup* with a clear message instead of
 * silently falling back to an insecure default.
 *
 * Rules:
 *  - `DATABASE_URL` is mandatory — there is no safe default database.
 *  - `JWT_SECRET` is mandatory outside development/test and must be long
 *    enough to be unguessable. Falling back to a hard-coded "dev-secret" in
 *    production would let anybody mint an ADMIN token.
 *  - Numeric knobs are parsed and range-checked here so a typo surfaces as a
 *    boot error rather than as `NaN` deep inside a query.
 */

import { startupStatus } from './startup-status';

export type AppEnv = {
  NODE_ENV: 'development' | 'test' | 'production';
  DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  /**
   * Optional Google OAuth client id (the public "Web application" client id).
   * When it is missing, the API reports Google sign-in as unconfigured and
   * the sign-in page hides the button instead of offering a dead end.
   */
  GOOGLE_CLIENT_ID?: string;
  PORT: number;
  CORS_ORIGINS: string;
  BCRYPT_ROUNDS: number;
  THROTTLE_TTL: number;
  THROTTLE_LIMIT: number;
  AUTH_THROTTLE_TTL: number;
  AUTH_THROTTLE_LIMIT: number;
  /** Optional Redis connection string — enables the shared rate-limit store. */
  REDIS_URL?: string;
  /** Whether `GET /api/metrics` is enabled. */
  METRICS_ENABLED: boolean;
};

const DEFAULTS = {
  JWT_SECRET: 'dev-secret',
  JWT_EXPIRES_IN: '7d',
  PORT: 4000,
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174',
  BCRYPT_ROUNDS: 12,
  THROTTLE_TTL: 60_000,
  THROTTLE_LIMIT: 300,
  AUTH_THROTTLE_TTL: 15 * 60_000,
  AUTH_THROTTLE_LIMIT: 10,
  METRICS_ENABLED: false,
} as const;

/** Minimal secret that must NOT be used outside local development. */
const INSECURE_SECRETS = new Set([
  'dev-secret',
  'change-me',
  'secret',
  'password',
  'assetflow',
]);

/**
 * Environment variables are always strings — anything else is ignored so a
 * malformed value can never be stringified into an object ("[object Object]").
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(
  value: unknown,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max} (received "${asString(value)}")`,
    );
  }
  return parsed;
}

/**
 * Booleans arrive as the strings `"true"` / `"false"` (or `"1"` / `"0"`).
 */
function asBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const raw = asString(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be "true" or "false" (received "${raw}").`);
}

/**
 * `ConfigModule.forRoot({ validate })` hook.
 *
 * @throws Error with an actionable message when the environment is unusable.
 */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const nodeEnv = (raw.NODE_ENV ?? 'development') as AppEnv['NODE_ENV'];

  const databaseUrl = asString(raw.DATABASE_URL).trim();
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy backend/.env.example to backend/.env and point it at your Postgres database.',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a postgresql:// connection string.');
  }

  const jwtSecret = asString(raw.JWT_SECRET).trim() || DEFAULTS.JWT_SECRET;
  if (nodeEnv === 'production') {
    if (jwtSecret === DEFAULTS.JWT_SECRET || INSECURE_SECRETS.has(jwtSecret)) {
      throw new Error(
        "JWT_SECRET must be set to a unique random value in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
      );
    }
    if (jwtSecret.length < 32) {
      throw new Error(
        'JWT_SECRET must be at least 32 characters long in production.',
      );
    }
  }

  const port = asInt(raw.PORT, DEFAULTS.PORT, 'PORT', 1, 65_535);

  // Optional: the shared store for the rate-limit counters. When it is set
  // the limits are global (all instances/replicas share them) instead of
  // per-process.
  const redisUrl = asString(raw.REDIS_URL).trim();
  if (redisUrl && !/^rediss?:\/\//i.test(redisUrl)) {
    throw new Error(
      'REDIS_URL must be a redis:// or rediss:// connection string.',
    );
  }

  const metricsEnabled = asBoolean(
    raw.METRICS_ENABLED,
    DEFAULTS.METRICS_ENABLED,
    'METRICS_ENABLED',
  );

  // Optional: the public Google OAuth client id. No client secret is needed
  // with the Google Identity Services ID-token flow.
  const googleClientId = asString(raw.GOOGLE_CLIENT_ID).trim();

  return {
    NODE_ENV: nodeEnv,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN:
      asString(raw.JWT_EXPIRES_IN).trim() || DEFAULTS.JWT_EXPIRES_IN,
    ...(googleClientId ? { GOOGLE_CLIENT_ID: googleClientId } : {}),
    PORT: port,
    CORS_ORIGINS: asString(raw.CORS_ORIGINS).trim() || DEFAULTS.CORS_ORIGINS,
    BCRYPT_ROUNDS: asInt(
      raw.BCRYPT_ROUNDS,
      DEFAULTS.BCRYPT_ROUNDS,
      'BCRYPT_ROUNDS',
      4,
      15,
    ),
    THROTTLE_TTL: asInt(
      raw.THROTTLE_TTL,
      DEFAULTS.THROTTLE_TTL,
      'THROTTLE_TTL',
      1_000,
      24 * 60 * 60 * 1_000,
    ),
    THROTTLE_LIMIT: asInt(
      raw.THROTTLE_LIMIT,
      DEFAULTS.THROTTLE_LIMIT,
      'THROTTLE_LIMIT',
      1,
      1_000_000,
    ),
    AUTH_THROTTLE_TTL: asInt(
      raw.AUTH_THROTTLE_TTL,
      DEFAULTS.AUTH_THROTTLE_TTL,
      'AUTH_THROTTLE_TTL',
      1_000,
      24 * 60 * 60 * 1_000,
    ),
    AUTH_THROTTLE_LIMIT: asInt(
      raw.AUTH_THROTTLE_LIMIT,
      DEFAULTS.AUTH_THROTTLE_LIMIT,
      'AUTH_THROTTLE_LIMIT',
      1,
      1_000_000,
    ),
    ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
    METRICS_ENABLED: metricsEnabled,
  };
}

/**
 * Validate the environment **without ever throwing**.
 *
 * `ConfigModule` calls the validator while the module is being imported. An
 * exception there kills the whole serverless function during import, which
 * Vercel reports as an opaque `500 FUNCTION_INVOCATION_FAILED` — the operator
 * never learns *which* variable was wrong.
 *
 * Instead the reason is recorded in `startupStatus`: the API keeps running,
 * answers `503` with the reason on every request, and `GET /api/health`
 * reports it.
 */
export function safeValidateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return validateEnv(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    startupStatus.setError(message);
    console.error(`[assetflow] invalid environment: ${message}`);
    // Keep the raw values so the rest of the app still sees what is set.
    return { ...raw };
  }
}
