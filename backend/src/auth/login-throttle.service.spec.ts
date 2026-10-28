import { ConfigService } from '@nestjs/config';

import { InMemoryLoginAttemptStore } from './login-throttle.store';
import {
  LoginThrottleService,
  TooManyRequestsException,
} from './login-throttle.service';

function config(values: Record<string, number>) {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('LoginThrottleService', () => {
  const env = { AUTH_THROTTLE_LIMIT: '3', AUTH_THROTTLE_TTL: '60000' };

  beforeEach(() => {
    process.env.AUTH_THROTTLE_LIMIT = env.AUTH_THROTTLE_LIMIT;
    process.env.AUTH_THROTTLE_TTL = env.AUTH_THROTTLE_TTL;
  });

  afterEach(() => {
    delete process.env.AUTH_THROTTLE_LIMIT;
    delete process.env.AUTH_THROTTLE_TTL;
  });

  it('blocks the key after the configured number of failures', async () => {
    const service = new LoginThrottleService(
      config({}),
      new InMemoryLoginAttemptStore(),
    );
    const key = 'ada@example.com|1.2.3.4';

    await service.recordFailure(key);
    await service.recordFailure(key);
    await expect(service.assertNotBlocked(key)).resolves.toBeUndefined();

    await service.recordFailure(key);
    await expect(service.assertNotBlocked(key)).rejects.toThrow(
      TooManyRequestsException,
    );
  });

  it('keeps different keys independent', async () => {
    const service = new LoginThrottleService(
      config({}),
      new InMemoryLoginAttemptStore(),
    );
    await service.recordFailure('a@example.com|1.1.1.1');
    await service.recordFailure('a@example.com|1.1.1.1');
    await service.recordFailure('a@example.com|1.1.1.1');

    await expect(
      service.assertNotBlocked('a@example.com|1.1.1.1'),
    ).rejects.toThrow();
    await expect(
      service.assertNotBlocked('b@example.com|1.1.1.1'),
    ).resolves.toBeUndefined();
  });

  it('clears the counter after a successful sign-in', async () => {
    const service = new LoginThrottleService(
      config({}),
      new InMemoryLoginAttemptStore(),
    );
    const key = 'ada@example.com|1.2.3.4';

    await service.recordFailure(key);
    await service.recordFailure(key);
    await service.recordSuccess(key);
    await service.recordFailure(key);

    await expect(service.assertNotBlocked(key)).resolves.toBeUndefined();
  });

  it('resets every key', async () => {
    const service = new LoginThrottleService(
      config({}),
      new InMemoryLoginAttemptStore(),
    );
    const key = 'ada@example.com|1.2.3.4';
    await service.recordFailure(key);
    await service.recordFailure(key);
    await service.recordFailure(key);
    await expect(service.assertNotBlocked(key)).rejects.toThrow();

    await service.reset();
    await expect(service.assertNotBlocked(key)).resolves.toBeUndefined();
  });

  it('honours the configured limit', async () => {
    // process.env wins over the injected config, so clear it for this case.
    delete process.env.AUTH_THROTTLE_LIMIT;
    const service = new LoginThrottleService(
      config({ AUTH_THROTTLE_LIMIT: 1 }),
      new InMemoryLoginAttemptStore(),
    );
    const key = 'ada@example.com|1.2.3.4';

    await service.recordFailure(key);
    await expect(service.assertNotBlocked(key)).rejects.toThrow();
  });

  it('reports which store it uses', () => {
    const memory = new LoginThrottleService(
      config({}),
      new InMemoryLoginAttemptStore(),
    );
    expect(memory.kind).toBe('memory');
  });
});
