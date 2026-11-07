import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Password-reset tokens.
 *
 * The rules are small but they are the whole security story of the feature:
 *
 *  * a token is 32 random bytes (256 bits) from the CSPRNG, base64url-encoded,
 *    so it cannot be guessed or enumerated;
 *  * only its SHA-256 **hash** is written to the database — a dump of
 *    `PasswordResetToken` therefore contains no usable link;
 *  * comparison is constant-time, so a wrong token cannot be found byte by
 *    byte by measuring response times;
 *  * a token expires after 30 minutes and is single-use.
 *
 * SHA-256 (not bcrypt) is deliberate: the input already has full 256-bit
 * entropy, so there is nothing to brute-force and no reason to spend 200 ms
 * hashing on a request an attacker can repeat.
 */

/** How long a reset link stays valid. */
export const RESET_TOKEN_TTL_MINUTES = 30;

/** The shape stored in the database. */
export type IssuedResetToken = {
  /** The value that travels in the e-mail link. Never stored. */
  token: string;
  /** What is stored: `sha256(token)` as hex. */
  hash: string;
  /** When the link stops working. */
  expiresAt: Date;
};

/** `sha256(token)` as lowercase hex — the only form that touches the database. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when two hex digests are equal, in constant time. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Mint a new token and the record that should be persisted for it. */
export function issueResetToken(now: Date = new Date()): IssuedResetToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashResetToken(token),
    expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000),
  };
}

/** Has this token expired at `now`? */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** The URL a user clicks in the e-mail. */
export function resetUrl(frontendUrl: string, token: string): string {
  const base = frontendUrl.replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}
