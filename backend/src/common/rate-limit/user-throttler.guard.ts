import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { throttleTracker, userIdFromAuthorization } from './throttle-key';

/**
 * A `ThrottlerGuard` that counts per **identity**, not only per IP.
 *
 * The default tracker is the client IP, which mis-fires in both directions:
 *
 *   - a whole office behind one NAT shares a single bucket (300 requests a
 *     minute for everybody), so one busy dashboard locks out its colleagues;
 *   - a load test from one machine can never exceed that ceiling, so it ends up
 *     measuring the rate limiter instead of the stack behind it.
 *
 * The bucket is `user:<id>` when the request carries a token that verifies, and
 * `ip:<address>` otherwise. The **limit is unchanged** — 300 requests per
 * minute — only the bucket is; a token that does not verify falls back to the
 * IP, so an attacker cannot mint a fresh bucket per request.
 *
 * This guard runs *before* the route guards, so `req.user` is not populated
 * yet — which is why the token is verified here rather than read off the
 * request. It is the same HS256 check `JwtStrategy` performs a moment later.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = req.headers as Record<string, unknown> | undefined;
    const userId = userIdFromAuthorization(
      headers?.authorization as string | string[] | undefined,
    );
    if (userId) return throttleTracker(userId, undefined);

    return throttleTracker(undefined, await super.getTracker(req));
  }
}
