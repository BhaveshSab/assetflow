import { safeValidateEnv, validateEnv } from './env.validation';
import { startupStatus } from './startup-status';

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

describe('safeValidateEnv', () => {
  beforeEach(() => startupStatus.clearError());

  it('returns the validated config when everything is fine', () => {
    const config = safeValidateEnv({ ...base });
    expect(config.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(startupStatus.getError()).toBeNull();
  });

  it('never throws — an invalid environment is recorded instead', () => {
    // A throw here would kill the serverless function during import, which
    // Vercel reports as an opaque 500 FUNCTION_INVOCATION_FAILED.
    const config = safeValidateEnv({
      ...base,
      NODE_ENV: 'production',
      JWT_SECRET: 'short',
    });
    expect(startupStatus.getError()).toMatch(/at least 32 characters/);
    // The raw values stay available so the rest of the app still sees them.
    expect(config.JWT_SECRET).toBe('short');
  });

  it('records a missing DATABASE_URL', () => {
    safeValidateEnv({ ...base, DATABASE_URL: '' });
    expect(startupStatus.getError()).toMatch(/DATABASE_URL is not set/);
  });
});

describe('validateEnv — mail, reset links and bootstrap', () => {
  it('defaults to the dev mail transport and a local front end', () => {
    const env = validateEnv({ ...base });
    expect(env.MAIL_TRANSPORT).toBe('dev');
    expect(env.FRONTEND_URL).toBe('http://localhost:5173');
    expect(env.SMTP_URL).toBeUndefined();
    expect(env.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
  });

  it('refuses the smtp transport without a connection string', () => {
    // A reset flow that cannot send is worse than a server that will not boot.
    expect(() => validateEnv({ ...base, MAIL_TRANSPORT: 'smtp' })).toThrow(
      /SMTP_URL is required/,
    );
  });

  it('refuses an unknown mail transport', () => {
    expect(() => validateEnv({ ...base, MAIL_TRANSPORT: 'sendmail' })).toThrow(
      /MAIL_TRANSPORT must be/,
    );
  });

  it('accepts the smtp transport with a connection string', () => {
    const env = validateEnv({
      ...base,
      MAIL_TRANSPORT: 'smtp',
      SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
      MAIL_FROM: 'AssetFlow <no-reply@example.com>',
    });
    expect(env.MAIL_TRANSPORT).toBe('smtp');
    expect(env.SMTP_URL).toBe('smtps://user:pass@smtp.example.com:465');
    expect(env.MAIL_FROM).toBe('AssetFlow <no-reply@example.com>');
  });

  it('requires an absolute FRONTEND_URL (the reset link must work off-machine)', () => {
    expect(() => validateEnv({ ...base, FRONTEND_URL: '/reset' })).toThrow(
      /absolute http\(s\) URL/,
    );
  });

  it('lower-cases BOOTSTRAP_ADMIN_EMAIL so it matches how accounts are stored', () => {
    const env = validateEnv({
      ...base,
      BOOTSTRAP_ADMIN_EMAIL: '  Ada@Example.COM ',
    });
    expect(env.BOOTSTRAP_ADMIN_EMAIL).toBe('ada@example.com');
  });
});
