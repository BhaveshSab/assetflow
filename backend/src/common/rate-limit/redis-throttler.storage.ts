import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';

/** The shape the throttler guard expects back from a storage. */
type ThrottlerRecord = {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
};

import { RedisService } from '../redis/redis.service';

/**
 * Atomic increment + block decision, executed inside Redis.
 *
 * KEYS[1] = counter key   KEYS[2] = block key
 * ARGV[1] = window (ms)   ARGV[2] = limit   ARGV[3] = block duration (ms)
 */
const INCREMENT_SCRIPT = `
local hits_key = KEYS[1]
local block_key = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block_duration = tonumber(ARGV[3])

local block_ttl = redis.call('PTTL', block_key)
if block_ttl > 0 then
  local blocked_hits = tonumber(redis.call('GET', hits_key) or '0')
  local blocked_window = redis.call('PTTL', hits_key)
  if blocked_window < 0 then blocked_window = ttl end
  return { blocked_hits, math.ceil(blocked_window / 1000), 1, math.ceil(block_ttl / 1000) }
end

local hits = redis.call('INCR', hits_key)
if hits == 1 then
  redis.call('PEXPIRE', hits_key, ttl)
end
local window_ttl = redis.call('PTTL', hits_key)
if window_ttl < 0 then window_ttl = ttl end

local is_blocked = 0
local block_expires = 0
if block_duration > 0 and hits > limit then
  redis.call('SET', block_key, '1', 'PX', block_duration)
  is_blocked = 1
  block_expires = math.ceil(block_duration / 1000)
end

return { hits, math.ceil(window_ttl / 1000), is_blocked, block_expires }
`;

/**
 * A `ThrottlerStorage` that keeps the rate-limit counters in Redis.
 *
 * Why: the built-in storage keeps the counters in the process memory. On a
 * serverless platform every cold start starts with an empty counter, and with
 * several replicas each one counts on its own — the effective limit is then
 * "limit x number of instances" and a restart clears it completely. Redis
 * makes the limit *global*.
 *
 * Availability: when Redis is unreachable this storage **fails open to the
 * in-process storage**. A monitoring system must not take the whole API down
 * because its rate limiter lost its shared store; the degradation is reported
 * through `GET /api/health` and a Prometheus gauge instead.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly fallback = new ThrottlerStorageService();
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    if (!this.redis.enabled) {
      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }

    const result = await this.redis.eval<[number, number, number, number]>(
      INCREMENT_SCRIPT,
      [
        `throttle:${throttlerName}:${key}`,
        `throttle:block:${throttlerName}:${key}`,
      ],
      [ttl, limit, blockDuration],
    );

    if (!result) {
      // Redis is down — keep serving, but with the local counter.
      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }

    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result;
    return {
      totalHits,
      timeToExpire,
      isBlocked: isBlocked === 1,
      timeToBlockExpire,
    };
  }
}
