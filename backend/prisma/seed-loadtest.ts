/**
 * The load-test fixture: accounts (and optionally assets) for a saturation run.
 *
 *   npm run seed:loadtest -- --users 30
 *   npm run seed:loadtest -- --users 30 --assets 5000
 *   npm run seed:loadtest -- --delete
 *
 * Why this exists: the API limits a client to 300 requests a minute. A load
 * test that reuses one account therefore measures the rate limiter, not the
 * stack — every request is over the same budget. This script creates N
 * accounts so each virtual user can carry its own budget, exactly like N
 * people with N browsers would.
 *
 * The password is **not** stored here: it arrives in `LOADTEST_PASSWORD`
 * (generated per run by `infra/scripts/load-test.sh`, thrown away afterwards).
 * Nobody can sign in to these accounts once the run is over, and `--delete`
 * removes them.
 */
import {
  AssetCondition,
  AssetStatus,
  RecordStatus,
  Role,
} from '@prisma/client';

import { hashPassword } from '../src/common/security/password';
import { createPrismaClient } from '../src/prisma/prisma.service';

const prisma = createPrismaClient(
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '',
);

const EMAIL_DOMAIN = 'assetflow.test';
const EMAIL_PREFIX = 'loadtest-';
const TAG_PREFIX = 'LT-';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function emailFor(index: number): string {
  return `${EMAIL_PREFIX}${String(index).padStart(3, '0')}@${EMAIL_DOMAIN}`;
}

/** Removes every row this script creates (assets first — they reference users). */
async function remove(): Promise<void> {
  const assets = await prisma.$executeRaw`
    DELETE FROM "Asset" WHERE "assetTag" LIKE ${`${TAG_PREFIX}%`}
  `;
  const users = await prisma.user.deleteMany({
    where: {
      AND: [
        { email: { startsWith: EMAIL_PREFIX } },
        { email: { endsWith: `@${EMAIL_DOMAIN}` } },
      ],
    },
  });
  console.log(`removed ${assets} load-test asset(s) and ${users.count} load-test account(s)`);
}

/**
 * Assets are inserted in SQL: 5,000 of them one `create()` at a time would take
 * longer than the test itself, and the point of them is to make the asset list
 * a realistic query (a sort over a table that does not fit in the CPU cache).
 */
async function seedAssets(count: number): Promise<void> {
  const category = await prisma.assetCategory.upsert({
    where: { name: 'Load test' },
    update: {},
    create: { name: 'Load test' },
  });

  await prisma.$executeRaw`
    INSERT INTO "Asset" (
      id, "assetTag", name, "serialNumber", "categoryId",
      status, condition, "isBookable", location, "createdAt", "updatedAt"
    )
    SELECT
      'lt-asset-' || g,
      ${TAG_PREFIX} || lpad(g::text, 6, '0'),
      'Load test asset ' || g,
      'LT-SN-' || g,
      ${category.id},
      ${AssetStatus.AVAILABLE}::"AssetStatus",
      ${AssetCondition.GOOD}::"AssetCondition",
      false,
      'Load test',
      now() - (g || ' seconds')::interval,
      now()
    FROM generate_series(1, ${count}) AS g
    ON CONFLICT ("assetTag") DO NOTHING
  `;
  console.log(`upserted up to ${count} asset(s) tagged ${TAG_PREFIX}NNNNNN`);
}

async function main(): Promise<void> {
  if (flag('delete')) {
    await remove();
    return;
  }

  const users = Number(arg('users', '30'));
  const assets = Number(arg('assets', '0'));
  const password = process.env.LOADTEST_PASSWORD;

  if (!Number.isInteger(users) || users < 1 || users > 500) {
    throw new Error('--users must be an integer between 1 and 500');
  }
  if (!Number.isInteger(assets) || assets < 0 || assets > 200_000) {
    throw new Error('--assets must be an integer between 0 and 200000');
  }
  if (users > 1 && !password) {
    throw new Error(
      'LOADTEST_PASSWORD is not set — more than one account needs a password. ' +
        'infra/scripts/load-test.sh generates one per run.',
    );
  }

  console.warn(
    `creating ${users} account(s) ${EMAIL_PREFIX}***@${EMAIL_DOMAIN} — ` +
      'delete them with: npm run seed:loadtest -- --delete',
  );

  // One hash is enough: every fixture account shares the run's password.
  const passwordHash = password
    ? await hashPassword(password, { rounds: Number(process.env.BCRYPT_ROUNDS ?? 12) })
    : undefined;

  for (let i = 1; i <= users; i++) {
    const email = emailFor(i);
    await prisma.user.upsert({
      where: { email },
      update: passwordHash
        ? { passwordHash, status: RecordStatus.ACTIVE }
        : { status: RecordStatus.ACTIVE },
      create: {
        email,
        name: `Load Test ${String(i).padStart(3, '0')}`,
        role: Role.EMPLOYEE,
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
  }
  console.log(`upserted ${users} account(s); the first is ${emailFor(1)}`);

  if (assets > 0) await seedAssets(assets);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
