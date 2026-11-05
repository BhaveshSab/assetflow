/**
 * The global rate limiter: does it count per person, and does it ever say no?
 *
 * Two things are checked by default, with the suite's wide-open limit
 * (`THROTTLE_LIMIT=1000000` in `test/global-setup.ts`):
 *
 *   1. the bucket belongs to the **user**, not the client IP — two people
 *      behind the same address do not share a counter;
 *   2. the throttler is configured with a **positive block duration**, which is
 *      what turns the counter into an actual 429. Without it the guard counts
 *      happily and never rejects anything (and the Redis script never even
 *      writes the block key).
 *
 * The third test observes a real 429 and is therefore skipped at the default
 * limit. Run it against the production ceiling (this is the run that produced
 * `docs/results/rate-limit-*.txt`):
 *
 *     THROTTLE_LIMIT=300 npm run test:e2e -- rate-limit
 */
import { INestApplication } from '@nestjs/common';
import { getOptionsToken, ThrottlerModuleOptions } from '@nestjs/throttler';
import request from 'supertest';

import { RedisThrottlerStorage } from '../src/common/rate-limit/redis-throttler.storage';
import {
  createTestApp,
  createUser,
  login,
  resetDatabase,
} from './utils/test-app';

const LIMIT = Number(process.env.THROTTLE_LIMIT ?? '1000000');

describe('rate limiting (e2e)', () => {
  let app: INestApplication;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    await createUser(app, {
      name: 'Alice Rate',
      email: 'alice.rate@example.com',
    });
    await createUser(app, { name: 'Bob Rate', email: 'bob.rate@example.com' });
    alice = await login(app, 'alice.rate@example.com');
    bob = await login(app, 'bob.rate@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  /** One authenticated GET, returning the rate-limit headers it carried. */
  async function hit(token: string) {
    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    return {
      status: res.status,
      limit: Number(res.headers['x-ratelimit-limit']),
      remaining: Number(res.headers['x-ratelimit-remaining']),
      retryAfter: res.headers['retry-after'],
    };
  }

  it('counts per user, not per client address', async () => {
    // Every request in this suite comes from the same address (supertest), so
    // an IP-keyed bucket would be shared. Alice spends three requests…
    const first = await hit(alice);
    expect(first.status).toBe(200);
    expect(first.limit).toBe(LIMIT);

    await hit(alice);
    const third = await hit(alice);

    // …and Bob's very first request still sees a full window, which can only
    // be true if his counter is keyed by his id.
    const bobFirst = await hit(bob);

    expect(third.remaining).toBeLessThanOrEqual(first.remaining - 2);
    expect(bobFirst.remaining).toBe(LIMIT - 1);
    expect(bobFirst.remaining).toBeGreaterThan(third.remaining);
  });

  it('is configured to block, not just to count', () => {
    // Regression guard: `blockDuration: 0` (the library default) makes the
    // memory store report "blocked" without a window to wait for, and makes
    // the Redis script skip the block key entirely — the API then answers 200
    // forever while the documentation claims 300 requests a minute.
    const options = app.get<ThrottlerModuleOptions>(getOptionsToken());
    const throttlers = Array.isArray(options) ? options : options.throttlers;

    expect(throttlers).toHaveLength(1);
    for (const throttler of throttlers) {
      expect(throttler.limit).toBe(LIMIT);
      expect(throttler.blockDuration).toBeGreaterThan(0);
      expect(throttler.blockDuration).toEqual(expect.any(Number));
    }
  });

  it('the shared store blocks the offender and leaves the colleague alone', async () => {
    // The store is the memory fallback here (no REDIS_URL in the suite), but
    // the contract is the one the Redis script implements.
    const storage = app.get(RedisThrottlerStorage);
    const key = `spec:${Date.now()}:${Math.random()}`;

    for (let i = 1; i <= 3; i += 1) {
      const record = await storage.increment(key, 60_000, 3, 30_000, 'default');
      expect(record.isBlocked).toBe(false);
      expect(record.totalHits).toBe(i);
    }

    const blocked = await storage.increment(key, 60_000, 3, 30_000, 'default');
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.timeToBlockExpire).toBeGreaterThan(0);

    // A different key (a different person) is unaffected.
    const other = await storage.increment(
      `${key}:other`,
      60_000,
      3,
      30_000,
      'default',
    );
    expect(other.isBlocked).toBe(false);
  });

  // Anything below the suite's wide-open default means someone asked for a
  // real ceiling, so the 429 is observable.
  const itNarrow = LIMIT < 1_000_000 ? it : it.skip;

  itNarrow('blocks request #LIMIT+1 with a Retry-After', async () => {
    // Only meaningful when the suite runs with a narrow limit, and it needs a
    // person with an untouched counter — the tests above already spent Bob's.
    await createUser(app, {
      name: 'Carol Rate',
      email: 'carol.rate@example.com',
    });
    const token = await login(app, 'carol.rate@example.com');

    const allowed: number[] = [];
    for (let i = 0; i < LIMIT; i += 1) allowed.push((await hit(token)).status);

    const rejected = await hit(token);

    expect(allowed.every((status) => status === 200)).toBe(true);
    expect(allowed).toHaveLength(LIMIT);
    expect(rejected.status).toBe(429);
    expect(Number(rejected.retryAfter)).toBeGreaterThan(0);
  });
});
