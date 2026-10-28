/**
 * Jest `globalSetup` for the end-to-end suite.
 *
 * Boots a **real PostgreSQL** (PGlite — Postgres compiled to WebAssembly) and
 * exposes it over the Postgres wire protocol, so the API talks to it with the
 * exact same driver adapter (`@prisma/adapter-pg`) it uses in production.
 * No Docker, no cloud database and no network access required.
 *
 * The schema is created by replaying the very same migration files that
 * `prisma migrate deploy` uses, so the tests exercise the shipped schema.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

/** Replay every migration folder in chronological order. */
async function applyMigrations(db: PGlite) {
  const folders = readdirSync(MIGRATIONS_DIR)
    .filter((name) => existsSync(join(MIGRATIONS_DIR, name, 'migration.sql')))
    .sort();

  for (const folder of folders) {
    const sql = readFileSync(
      join(MIGRATIONS_DIR, folder, 'migration.sql'),
      'utf8',
    );
    await db.exec(sql);
  }
  return folders.length;
}

export default async function globalSetup() {
  const db = await PGlite.create();
  // Port 0 lets the OS pick a free port. A fixed port is not portable: on
  // Windows + Hyper-V, WinNAT reserves whole ranges (e.g. 54259–54358), and
  // binding inside one fails with EACCES. `TEST_PG_PORT` still overrides it.
  const requestedPort = process.env.TEST_PG_PORT
    ? Number(process.env.TEST_PG_PORT)
    : 0;

  const server = new PGLiteSocketServer({
    db,
    port: requestedPort,
    host: '127.0.0.1',
    // The default is 1 — the API opens a small pool, so allow a few clients.
    maxConnections: 20,
  });
  await server.start();

  // `getServerConn()` reports the port the OS actually bound ("host:port").
  const address = server.getServerConn();
  const applied = await applyMigrations(db);

  console.log(
    `\n🧪 Test database ready on ${address} (${applied} migration(s) applied)\n`,
  );

  // The workers inherit this environment.
  process.env.DATABASE_URL = `postgresql://postgres:postgres@${address}/postgres`;
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-production-000000';
  process.env.JWT_EXPIRES_IN = '1h';
  process.env.NODE_ENV = 'test';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  process.env.PORT = '4000';
  // Keep the hashing cheap and the throttles wide open — the suites would
  // otherwise spend most of their time hashing and waiting for 429s.
  process.env.BCRYPT_ROUNDS = '4';
  process.env.THROTTLE_LIMIT = '1000000';
  process.env.THROTTLE_TTL = '60000';
  process.env.AUTH_THROTTLE_LIMIT = '1000';
  process.env.AUTH_THROTTLE_TTL = '60000';
  // Google sign-in is optional and needs a real client id; the suite covers
  // the "not configured" path. The configured path is unit-tested with a
  // mocked token verifier.
  delete process.env.GOOGLE_CLIENT_ID;

  return async () => {
    await server.stop();
    await db.close();
  };
}
