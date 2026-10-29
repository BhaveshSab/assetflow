import { JwtService } from '@nestjs/jwt';

/**
 * How a request is grouped for rate limiting.
 *
 * Two requests share a bucket only when this function returns the same string
 * for both — so the value decides what a "client" is.
 *
 * - `user:<id>` — the request carries a bearer token whose signature and
 *   expiry check out. The bucket is per *person*.
 * - `ip:<address>` — everything else. The bucket is per network address.
 * - `undefined` — the caller falls back to the IP tracker.
 */

const jwt = new JwtService({});

/** The secret the API signs its tokens with (the same one JwtStrategy uses). */
function secret(): string {
  return process.env.JWT_SECRET ?? 'dev-secret';
}

/**
 * The `sub` claim of a **verified** bearer token, or `undefined`.
 *
 * The token is verified, not decoded: a request that invents a `sub` gets
 * `undefined` and lands in its IP bucket, so a new identity cannot be minted
 * per request to dodge the limit.
 *
 * A token signed with another secret, an expired one, and a malformed one all
 * take the same path — the request is then limited by IP, and the auth guard
 * rejects it a moment later anyway.
 */
export function userIdFromAuthorization(
  authorization: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (typeof header !== 'string') return undefined;

  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!match) return undefined;

  try {
    const payload = jwt.verify<{ sub?: unknown }>(match[1].trim(), {
      secret: secret(),
    });
    const sub = payload?.sub;
    return typeof sub === 'string' && sub.length > 0 ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** The tracker string for a request the throttler guard is about to count. */
export function throttleTracker(
  userId: string | undefined,
  clientIp: string | undefined,
): string {
  return userId ? `user:${userId}` : `ip:${clientIp ?? 'unknown'}`;
}
