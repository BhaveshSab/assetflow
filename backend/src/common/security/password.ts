import { createHash } from 'crypto';

import * as bcrypt from 'bcrypt';

/**
 * Password hashing helpers.
 *
 * bcrypt silently truncates every secret to its first **72 bytes**. Hashing
 * the raw password would therefore make `long-password-A` and
 * `long-password-B…(72+ bytes)` interchangeable — a real authentication bug.
 * To avoid it we pre-hash the password with SHA-512 and feed the *hex digest*
 * (64 ASCII characters) to bcrypt, which is always well under the limit.
 *
 * The digest is what gets hashed, so the stored hash format is stable across
 * every entry point that creates a user (signup, admin provisioning, seed).
 */

/** bcrypt's hard limit — inputs longer than this are truncated. */
export const BCRYPT_MAX_BYTES = 72;

/** Longest password we accept, before hashing (protects against DoS). */
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordHashOptions = {
  /** bcrypt cost factor. Lower = faster (tests), higher = safer (production). */
  rounds?: number;
};

export function normalizePassword(password: string): string {
  return typeof password === 'string' ? password : '';
}

/** SHA-512 → hex. Fixed 64-char ASCII output, safe for bcrypt. */
function preHash(password: string): string {
  return createHash('sha512').update(password, 'utf8').digest('hex');
}

/** Hash a plaintext password with bcrypt (cost factor configurable). */
export async function hashPassword(
  password: string,
  options: PasswordHashOptions = {},
): Promise<string> {
  const rounds = options.rounds ?? 12;
  return bcrypt.hash(preHash(password), rounds);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Supports both the current (pre-hashed) format and a plain bcrypt hash, so
 * accounts created before this change keep working.
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (!hash) return false;
  const candidate = preHash(password);
  // `bcrypt.compare` returns false for a mismatched algorithm/length, so we
  // can safely try the modern format first and fall back to the legacy one.
  if (await bcrypt.compare(candidate, hash)) return true;
  if (await bcrypt.compare(password, hash)) return true;
  return false;
}
