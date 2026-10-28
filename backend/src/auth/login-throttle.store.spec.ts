import { RedisService } from '../common/redis/redis.service';
import {
  InMemoryLoginAttemptStore,
  RedisLoginAttemptStore,
} from './login-throttle.store';

function redisDouble(options: { enabled?: boolean; fail?: boolean } = {}) {
  const state = new Map<string, { failures: number; blockedUntil: number }>();
  const service = {
    enabled: options.enabled ?? true,
    getClient: () => ({}) as never,
    eval: async <T>(
      _script: string,
      keys: string[],
      args: (string | number)[],
    ) => {
      if (options.fail) return null;
      const key = keys[0];
      const entry = state.get(key) ?? { failures: 0, blockedUntil: 0 };

      if (args.length === 1) {
        // isBlocked(now)
        const now = Number(args[0]);
        return (entry.blockedUntil > now ? entry.blockedUntil - now : 0) as T;
      }

      // recordFailure(window, limit, now)
      const limit = Number(args[1]);
      const now = Number(args[2]);
      entry.failures += 1;
      if (entry.failures >= limit) entry.blockedUntil = now + 60_000;
      state.set(key, entry);
      return entry.failures as T;
    },
    del: async (key: string) => {
      state.delete(key);
      return true;
    },
  };
  return { service: service as unknown as RedisService, state };
}

describe('InMemoryLoginAttemptStore', () => {
  it('blocks the key once the limit is reached', async () => {
    const store = new InMemoryLoginAttemptStore();
    await store.recordFailure('a|1.1.1.1', 2, 60_000);
    expect(await store.isBlocked('a|1.1.1.1')).toBe(0);
    await store.recordFailure('a|1.1.1.1', 2, 60_000);
    expect(await store.isBlocked('a|1.1.1.1')).toBeGreaterThan(0);
  });

  it('clears the counter on success', async () => {
    const store = new InMemoryLoginAttemptStore();
    await store.recordFailure('a|1.1.1.1', 1, 60_000);
    await store.recordSuccess('a|1.1.1.1');
    expect(await store.isBlocked('a|1.1.1.1')).toBe(0);
  });
});

describe('RedisLoginAttemptStore', () => {
  it('shares the counters through Redis', async () => {
    const { service, state } = redisDouble();
    const store = new RedisLoginAttemptStore(service);

    await store.recordFailure('a|1.1.1.1', 2, 60_000);
    expect(await store.isBlocked('a|1.1.1.1')).toBe(0);
    await store.recordFailure('a|1.1.1.1', 2, 60_000);
    expect(await store.isBlocked('a|1.1.1.1')).toBeGreaterThan(0);
    expect(state.size).toBe(1);
  });

  it('falls back to the local limiter when Redis is down', async () => {
    const { service } = redisDouble({ fail: true });
    const store = new RedisLoginAttemptStore(service);

    await store.recordFailure('a|1.1.1.1', 2, 60_000);
    await store.recordFailure('a|1.1.1.1', 2, 60_000);
    // The local limiter still blocks — the API never loses its protection.
    expect(await store.isBlocked('a|1.1.1.1')).toBeGreaterThan(0);
  });

  it('uses the local store when Redis is not configured', async () => {
    const { service } = redisDouble({ enabled: false });
    const store = new RedisLoginAttemptStore(service);

    await store.recordFailure('a|1.1.1.1', 1, 60_000);
    expect(await store.isBlocked('a|1.1.1.1')).toBeGreaterThan(0);
  });
});
