import { queueConnection } from './queue-config';

describe('Dedicated jobs Redis configuration', () => {
  it('requires a separate explicit URL', () => {
    expect(() => queueConnection(undefined)).toThrow('JOBS_REDIS_URL');
    expect(() => queueConnection('https://example.test')).toThrow('redis://');
  });
  it('supports TLS, authentication and database selection', () => {
    const c = queueConnection('rediss://worker:p%40ss@example.test:6380/2');
    expect(c).toMatchObject({
      host: 'example.test',
      port: 6380,
      username: 'worker',
      password: 'p@ss',
      db: 2,
      tls: {},
    });
  });
  it('rejects invalid databases', () => {
    expect(() => queueConnection('redis://example.test/not-a-db')).toThrow(
      'database',
    );
  });
});
