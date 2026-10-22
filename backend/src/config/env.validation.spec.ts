import { validateEnv } from './env.validation';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/assetflow',
  JWT_SECRET: 'a'.repeat(48),
};

describe('validateEnv', () => {
  it('accepts a complete environment', () => {
    const env = validateEnv({ ...base });
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(env.PORT).toBe(4000);
    expect(env.JWT_EXPIRES_IN).toBe('7d');
    expect(env.BCRYPT_ROUNDS).toBe(12);
  });

  it('fails fast without a DATABASE_URL', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: '' })).toThrow(
      /DATABASE_URL is not set/,
    );
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      validateEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/postgresql:\/\//);
  });

  it('refuses the placeholder JWT secret in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'change-me' }),
    ).toThrow(/JWT_SECRET/);
  });

  it('refuses a short JWT secret in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'short' }),
    ).toThrow(/at least 32 characters/);
  });

  it('allows the development fallback outside production', () => {
    const env = validateEnv({
      ...base,
      NODE_ENV: 'development',
      JWT_SECRET: '',
    });
    expect(env.JWT_SECRET).toBe('dev-secret');
  });

  it('rejects a non-numeric port', () => {
    expect(() => validateEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a nonsense bcrypt cost', () => {
    expect(() => validateEnv({ ...base, BCRYPT_ROUNDS: '99' })).toThrow(
      /BCRYPT_ROUNDS/,
    );
  });
});
