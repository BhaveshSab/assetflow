/**
 * Applies the Prisma migrations to the right database.
 *
 * Prisma needs a **direct** connection for migrations: PgBouncer (Neon's
 * pooled endpoint) does not support the session state a migration requires —
 * `prisma migrate deploy` fails with "Prisma Migrate requires a direct
 * connection to the database".
 *
 * So when `DATABASE_URL_UNPOOLED` is set (the direct Neon URL) it is used for
 * the migration, while the application keeps using the pooled `DATABASE_URL`.
 *
 *   DATABASE_URL="postgresql://…-pooler.…/db" \
 *   DATABASE_URL_UNPOOLED="postgresql://….neon.tech/db" \
 *   npm run prisma:migrate
 */
const { spawnSync } = require('child_process');

const unpooled = process.env.DATABASE_URL_UNPOOLED;
const connectionString = unpooled || process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    'Neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set — nothing to migrate.',
  );
  process.exit(1);
}

if (unpooled) {
  console.log('→ migrating with DATABASE_URL_UNPOOLED (direct connection)');
}

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: connectionString },
});

process.exit(result.status ?? 1);
