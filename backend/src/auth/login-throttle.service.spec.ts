import { ConfigService } from '@nestjs/config';

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

  it('blocks the key after the configured number of failures', () => {
    const service = new LoginThrottleService(config({}));
    const key = 'ada@example.com|1.2.3.4';

    service.recordFailure(key);
    service.recordFailure(key);
    expect(() => service.assertNotBlocked(key)).not.toThrow();

    service.recordFailure(key);
    expect(() => service.assertNotBlocked(key)).toThrow(
      TooManyRequestsException,
    );
  });

  it('keeps different keys independent', () => {
    const service = new LoginThrottleService(config({}));
    service.recordFailure('a@example.com|1.1.1.1');
    service.recordFailure('a@example.com|1.1.1.1');
    service.recordFailure('a@example.com|1.1.1.1');

    expect(() => service.assertNotBlocked('a@example.com|1.1.1.1')).toThrow();
    expect(() =>
      service.assertNotBlocked('b@example.com|1.1.1.1'),
    ).not.toThrow();
  });

  it('clears the counter after a successful sign-in', () => {
    const service = new LoginThrottleService(config({}));
    const key = 'ada@example.com|1.2.3.4';

    service.recordFailure(key);
    service.recordFailure(key);
    service.recordSuccess(key);
    service.recordFailure(key);

    expect(() => service.assertNotBlocked(key)).not.toThrow();
  });

  it('resets every key', () => {
    const service = new LoginThrottleService(config({}));
    const key = 'ada@example.com|1.2.3.4';
    service.recordFailure(key);
    service.recordFailure(key);
    service.recordFailure(key);
    expect(() => service.assertNotBlocked(key)).toThrow();

    service.reset();
    expect(() => service.assertNotBlocked(key)).not.toThrow();
  });

  it('honours the configured limit', () => {
    // process.env wins over the injected config, so clear it for this case.
    delete process.env.AUTH_THROTTLE_LIMIT;
    const service = new LoginThrottleService(
      config({ AUTH_THROTTLE_LIMIT: 1 }),
    );
    const key = 'ada@example.com|1.2.3.4';

    service.recordFailure(key);
    expect(() => service.assertNotBlocked(key)).toThrow();
  });
});
