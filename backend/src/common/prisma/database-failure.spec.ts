import { Prisma } from '@prisma/client';
import { databaseFailure } from './database-failure';
const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('PRIVATE SQL/credentials', {
    code,
    clientVersion: 'test',
  });
describe('Database failure classification', () => {
  it.each(['P2021', 'P2022'])(
    'classifies missing schema %s without leaking internals',
    (code) => {
      const result = databaseFailure(known(code));
      expect(result.status).toBe(503);
      expect(result.code).toBe('DATABASE_SCHEMA_NOT_READY');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );
  it.each(['P1000', 'P1001', 'P1002', 'P2024', 'P2037'])(
    'classifies dependency failure %s',
    (code) => expect(databaseFailure(known(code)).status).toBe(503),
  );
  it.each([
    ['P2002', 409],
    ['P2003', 409],
    ['P2025', 404],
    ['P2034', 409],
  ])('preserves expected database failures %s', (code, status) =>
    expect(databaseFailure(known(String(code))).status).toBe(status),
  );
  it('keeps unexpected failures as HTTP 500, never fake success', () => {
    expect(databaseFailure(known('P9999')).status).toBe(500);
    expect(databaseFailure(new Error('secret')).message).not.toContain(
      'secret',
    );
  });
});
