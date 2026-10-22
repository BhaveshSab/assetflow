/**
 * E-mail normalisation.
 *
 * Addresses are stored lower-cased and trimmed so that "A@B.com" and
 * "a@b.com" are the *same* account. Without this, a case-sensitive unique
 * index would happily create two accounts for one person — and a sign-in
 * with a different capitalisation would fail.
 */

/** Lower-cases and trims an e-mail address. */
export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

/** Case-insensitive "does this address already exist?" filter. */
export function emailEquals(email: string): {
  equals: string;
  mode: 'insensitive';
} {
  return { equals: normalizeEmail(email), mode: 'insensitive' };
}
