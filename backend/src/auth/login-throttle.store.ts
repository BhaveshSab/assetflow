import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';

/**
 * Where the failed-sign-in counters live.
 *
 * Two implementations:
 *  - {@link InMemoryLoginAttemptStore} — the default, a `Map` in the process.
 *  - {@link RedisLoginAttemptStore} — shared between every instance.
 */
export interface LoginAttemptStore {
  /** Which implementation is in use (`memory` / `redis`). */
  readonly kind: 'memory' | 'redis';

  /**
   * Is the key currently blocked?
   * @returns the remaining block time in milliseconds (0 when not blocked).
   */
  isBlocked(key: string): Promise<number>;

  /** Register a failed attempt; blocks the key once the limit is reached. */
  recordFailure(key: string, limit: number, windowMs: number): Promise<void>;

  /** A successful sign-in wipes the counter for that key. */
  recordSuccess(key: string): Promise<void>;

  /** Drop every tracked key (used by the test-suite). */
  reset(): Promise<void>;
}

type AttemptRecord = {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
};

/** Hard cap so a flood of unique keys can never grow the map without bound. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * The in-process store — one map per running instance.
 *
 * Correct for a single instance; with several replicas the counters are not
 * shared, which is exactly what {@link RedisLoginAttemptStore} fixes.
 */
@Injectable()
export class InMemoryLoginAttemptStore implements LoginAttemptStore {
  readonly kind = 'memory' as const;
  private readonly attempts = new Map<string, AttemptRecord>();

  isBlocked(key: string): Promise<number> {
    const record = this.attempts.get(key);
    if (!record) return Promise.resolve(0);

    const now = Date.now();
    if (record.blockedUntil > now) {
      return Promise.resolve(record.blockedUntil - now);
    }

    // The block expired — start a fresh window on the next failure.
    if (record.blockedUntil !== 0) this.attempts.delete(key);
    return Promise.resolve(0);
  }

  recordFailure(key: string, limit: number, windowMs: number): Promise<void> {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || now - record.firstFailureAt > windowMs) {
      this.pruneIfNeeded();
      this.attempts.set(key, {
        failures: 1,
        firstFailureAt: now,
        blockedUntil: limit <= 1 ? now + windowMs : 0,
      });
      return Promise.resolve();
    }

    record.failures += 1;
    if (record.failures >= limit) record.blockedUntil = now + windowMs;
    return Promise.resolve();
  }

  recordSuccess(key: string): Promise<void> {
    this.attempts.delete(key);
    return Promise.resolve();
  }

  reset(): Promise<void> {
    this.attempts.clear();
    return Promise.resolve();
  }

  /** Keeps the map bounded — drops the oldest entries when it grows too big. */
  private pruneIfNeeded(): void {
    if (this.attempts.size < MAX_TRACKED_KEYS) return;
    const now = Date.now();
    for (const [key, record] of this.attempts) {
      if (record.blockedUntil <= now) this.attempts.delete(key);
    }
    // Still too big (all entries are blocked): drop the oldest ones.
    while (this.attempts.size >= MAX_TRACKED_KEYS) {
      const oldest = this.attempts.keys().next();
      if (oldest.done) break;
      this.attempts.delete(oldest.value);
    }
  }
}

/**
 * KEYS[1] = throttle key
 * ARGV[1] = window (ms)   ARGV[2] = limit   ARGV[3] = now (ms)
 */
const RECORD_FAILURE_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local state = redis.call('HMGET', key, 'failures', 'firstFailureAt', 'blockedUntil')
local failures = tonumber(state[1]) or 0
local first_failure = tonumber(state[2]) or 0
local blocked_until = tonumber(state[3]) or 0

if first_failure == 0 or (now - first_failure) > window then
  failures = 0
  first_failure = now
end

failures = failures + 1
if failures >= limit then
  blocked_until = now + window
end

redis.call('HSET', key, 'failures', failures, 'firstFailureAt', first_failure, 'blockedUntil', blocked_until)
redis.call('PEXPIRE', key, window)
return failures
`;

/**
 * KEYS[1] = throttle key   ARGV[1] = now (ms)
 */
const IS_BLOCKED_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local blocked_until = tonumber(redis.call('HGET', key, 'blockedUntil') or '0')
if blocked_until > now then
  return blocked_until - now
end
if blocked_until > 0 then
  redis.call('DEL', key)
end
return 0
`;

/**
 * The shared store — every instance of the API sees the same counters.
 *
 * This closes a real hole: with the in-process store a restart (or a new
 * serverless instance) resets the brute-force counter, and with several
 * replicas an attacker gets `limit x replicas` attempts.
 *
 * Availability: if Redis is unreachable the store **fails open to the
 * in-process store**, so the API keeps working (and keeps a per-instance
 * limit) instead of rejecting every sign-in.
 */
@Injectable()
export class RedisLoginAttemptStore implements LoginAttemptStore {
  readonly kind = 'redis' as const;
  private readonly local = new InMemoryLoginAttemptStore();
  private readonly logger = new Logger(RedisLoginAttemptStore.name);

  constructor(private readonly redis: RedisService) {}

  async isBlocked(key: string): Promise<number> {
    if (!this.redis.enabled) return this.local.isBlocked(key);

    const blocked = await this.redis.eval<number>(
      IS_BLOCKED_SCRIPT,
      [`auth:throttle:${key}`],
      [Date.now()],
    );

    if (blocked === null) {
      this.logger.warn(
        'Redis is unavailable — using the local sign-in limiter',
      );
      return this.local.isBlocked(key);
    }
    return blocked;
  }

  async recordFailure(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<void> {
    if (!this.redis.enabled) {
      await this.local.recordFailure(key, limit, windowMs);
      return;
    }

    const failures = await this.redis.eval<number>(
      RECORD_FAILURE_SCRIPT,
      [`auth:throttle:${key}`],
      [windowMs, limit, Date.now()],
    );

    if (failures === null) {
      this.logger.warn(
        'Redis is unavailable — using the local sign-in limiter',
      );
      await this.local.recordFailure(key, limit, windowMs);
    }
  }

  async recordSuccess(key: string): Promise<void> {
    await this.local.recordSuccess(key);
    if (!this.redis.enabled) return;
    await this.redis.del(`auth:throttle:${key}`);
  }

  async reset(): Promise<void> {
    await this.local.reset();
  }
}
