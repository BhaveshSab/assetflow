import { RedisThrottlerStorage } from './redis-throttler.storage';
import { RedisService } from '../redis/redis.service';

type ScriptCall = { keys: string[]; args: (string | number)[] };

/**
 * A Redis double: it records the scripts and answers with what a real Redis
 * would answer for the "3 hits, limit 2" case.
 */
function redisDouble(options: { enabled?: boolean; fail?: boolean } = {}) {
  const calls: ScriptCall[] = [];
  const service = {
    enabled: options.enabled ?? true,
    getClient: () => ({}) as never,
    eval: async <T>(
      _script: string,
      keys: string[],
      args: (string | number)[],
    ) => {
      calls.push({ keys, args });
      if (options.fail) return null;
      return [3, 60, 1, 30] as unknown as T;
    },
    del: async () => true,
  };
  return {
    calls,
    service: service as unknown as RedisService,
  };
}

describe('RedisThrottlerStorage', () => {
  it('keeps the counters in Redis when it is configured', async () => {
    const { service, calls } = redisDouble();
    const storage = new RedisThrottlerStorage(service);

    const record = await storage.increment(
      '1.2.3.4',
      60_000,
      2,
      30_000,
      'default',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].keys[0]).toContain('throttle:default:1.2.3.4');
    expect(calls[0].args).toEqual([60_000, 2, 30_000]);
    expect(record).toEqual({
      totalHits: 3,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
  });

  it('never touches Redis when it is not configured', async () => {
    const { service, calls } = redisDouble({ enabled: false });
    const storage = new RedisThrottlerStorage(service);

    const record = await storage.increment('1.2.3.4', 60_000, 2, 0, 'default');

    expect(calls).toHaveLength(0);
    expect(record.totalHits).toBe(1);
    expect(record.isBlocked).toBe(false);
  });

  it('fails open to the local counter when Redis is down', async () => {
    const { service } = redisDouble({ fail: true });
    const storage = new RedisThrottlerStorage(service);

    // The API must keep serving: the request is counted locally instead.
    const record = await storage.increment('1.2.3.4', 60_000, 2, 0, 'default');
    expect(record.totalHits).toBe(1);
    expect(record.isBlocked).toBe(false);
  });

  it('blocks once the limit is exceeded', async () => {
    const { service } = redisDouble();
    const storage = new RedisThrottlerStorage(service);

    await storage.increment('1.2.3.4', 60_000, 1, 30_000, 'default');
    const record = await storage.increment(
      '1.2.3.4',
      60_000,
      1,
      30_000,
      'default',
    );

    expect(record.isBlocked).toBe(true);
    expect(record.totalHits).toBeGreaterThan(1);
  });
});
