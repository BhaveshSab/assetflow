import { JwtService } from '@nestjs/jwt';

import { throttleTracker, userIdFromAuthorization } from './throttle-key';

const SECRET = 'unit-test-secret-that-is-long-enough-000000';

function sign(
  payload: Record<string, unknown>,
  options: { secret?: string } = {},
): string {
  return new JwtService({}).sign(payload, { secret: options.secret ?? SECRET });
}

describe('the rate-limit tracker', () => {
  const previous = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  });

  describe('an authenticated request', () => {
    it('is tracked by the user id of a verified token', () => {
      const token = sign({ sub: 'user-1', role: 'ADMIN' });

      expect(userIdFromAuthorization(`Bearer ${token}`)).toBe('user-1');
      expect(throttleTracker('user-1', undefined)).toBe('user:user-1');
    });

    it('accepts the scheme case-insensitively and any spacing', () => {
      const token = sign({ sub: 'user-1' });

      expect(userIdFromAuthorization(`bearer   ${token}`)).toBe('user-1');
    });

    it('reads the first value of a repeated header', () => {
      const token = sign({ sub: 'user-1' });

      expect(userIdFromAuthorization([`Bearer ${token}`, 'Bearer junk'])).toBe(
        'user-1',
      );
    });
  });

  describe('anything it cannot verify falls back to the IP bucket', () => {
    it('has no user for a missing header', () => {
      expect(userIdFromAuthorization(undefined)).toBeUndefined();
      expect(userIdFromAuthorization('')).toBeUndefined();
    });

    it('has no user for a header that is not a bearer token', () => {
      expect(userIdFromAuthorization('Basic dXNlcjpwYXNz')).toBeUndefined();
    });

    it('has no user for a token signed with another secret', () => {
      // The important case: an attacker cannot mint a fresh bucket per request
      // by inventing a `sub` — an unverifiable token is counted by IP.
      const forged = sign(
        { sub: 'someone-else' },
        { secret: 'not-the-secret' },
      );

      expect(userIdFromAuthorization(`Bearer ${forged}`)).toBeUndefined();
    });

    it('has no user for an expired token', () => {
      const expired = sign({
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) - 60,
      });

      expect(userIdFromAuthorization(`Bearer ${expired}`)).toBeUndefined();
    });

    it('has no user for a token without a subject', () => {
      const token = sign({ role: 'ADMIN' });

      expect(userIdFromAuthorization(`Bearer ${token}`)).toBeUndefined();
    });

    it('has no user for junk, which is not an error', () => {
      expect(userIdFromAuthorization('Bearer not-a-jwt')).toBeUndefined();
    });
  });

  describe('the bucket name', () => {
    it('separates a user from an IP that would collide with it', () => {
      expect(throttleTracker(undefined, '10.0.0.1')).toBe('ip:10.0.0.1');
      expect(throttleTracker('10.0.0.1', undefined)).toBe('user:10.0.0.1');
      expect(throttleTracker(undefined, undefined)).toBe('ip:unknown');
    });
  });
});
