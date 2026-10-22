import {
  FALLBACK_CONNECTION_STRING,
  createAdapter,
  hostOf,
  isNeonPoolerUrl,
  isNeonUrl,
  selectDriver,
} from './prisma.service';

describe('database driver selection', () => {
  const DIRECT =
    'postgresql://user:pw@ep-abc.us-east-2.aws.neon.tech/assetflow?sslmode=require';
  const POOLED =
    'postgresql://user:pw@ep-abc-pooler.us-east-2.aws.neon.tech/assetflow?sslmode=require';
  const LOCAL = 'postgresql://assetflow:assetflow@localhost:5433/assetflow';

  describe('hostOf', () => {
    it('extracts the hostname', () => {
      expect(hostOf(DIRECT)).toBe('ep-abc.us-east-2.aws.neon.tech');
      expect(hostOf(LOCAL)).toBe('localhost');
    });

    it('never throws on a broken URL', () => {
      expect(() => hostOf('not a url')).not.toThrow();
    });
  });

  describe('isNeonUrl', () => {
    it('detects Neon hosts', () => {
      expect(isNeonUrl(DIRECT)).toBe(true);
      expect(isNeonUrl(POOLED)).toBe(true);
    });

    it('ignores other hosts', () => {
      expect(isNeonUrl(LOCAL)).toBe(false);
      expect(isNeonUrl('postgresql://user:pw@db.example.com:5432/x')).toBe(
        false,
      );
    });
  });

  describe('isNeonPoolerUrl', () => {
    it('detects the pooled endpoint', () => {
      expect(isNeonPoolerUrl(POOLED)).toBe(true);
    });

    it('does not confuse the direct endpoint', () => {
      expect(isNeonPoolerUrl(DIRECT)).toBe(false);
      expect(isNeonPoolerUrl(LOCAL)).toBe(false);
    });
  });

  describe('selectDriver', () => {
    it('uses the Neon WebSocket driver for a direct Neon URL', () => {
      // The direct endpoint speaks the Neon WebSocket protocol.
      expect(selectDriver(DIRECT)).toBe('neon-websocket');
    });

    it('uses plain TCP for the pooled Neon endpoint', () => {
      // PgBouncer only speaks the Postgres wire protocol — the WebSocket
      // driver cannot connect to it.
      expect(selectDriver(POOLED)).toBe('pg');
    });

    it('uses plain TCP for every other database', () => {
      expect(selectDriver(LOCAL)).toBe('pg');
      expect(
        selectDriver('postgresql://user:pw@db.supabase.co:5432/postgres'),
      ).toBe('pg');
    });
  });

  describe('createAdapter', () => {
    it('creates an adapter for every supported URL', () => {
      expect(createAdapter(DIRECT)).toBeDefined();
      expect(createAdapter(POOLED)).toBeDefined();
      expect(createAdapter(LOCAL)).toBeDefined();
    });
  });

  describe('FALLBACK_CONNECTION_STRING', () => {
    it('is a valid, unreachable connection string', () => {
      // Used when DATABASE_URL is missing: the client must still be
      // constructible so the process can start and report the problem.
      expect(() => createAdapter(FALLBACK_CONNECTION_STRING)).not.toThrow();
    });
  });
});
