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
  const port = Number(process.env.TEST_PG_PORT ?? 54329);

  const server = new PGLiteSocketServer({
    db,
    port,
    host: '127.0.0.1',
    // The default is 1 — the API opens a small pool, so allow a few clients.
    maxConnections: 20,
  });
  await server.start();

  const applied = await applyMigrations(db);

  console.log(
    `\n🧪 Test database ready on 127.0.0.1:${port} (${applied} migration(s) applied)\n`,
  );

  // The workers inherit this environment.
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
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

  return async () => {
    await server.stop();
    await db.close();
  };
}
