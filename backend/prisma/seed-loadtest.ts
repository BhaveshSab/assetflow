/**
 * The load-test fixture: accounts (and optionally assets) for a saturation run.
 *
 *   npm run seed:loadtest -- --run-id <id> --users 30
 *   npm run seed:loadtest -- --run-id <id> --users 30 --assets 5000
 *   npm run seed:loadtest -- --run-id <id> --delete
 *
 * Why this exists: the API limits a client to 300 requests a minute. A load
 * test that reuses one account therefore measures the rate limiter, not the
 * stack — every request is over the same budget. This script creates N
 * accounts so each virtual user can carry its own budget, exactly like N
 * people with N browsers would.
 *
 * Ownership. Every row is named after the run that created it
 * (`loadtest-<run-id>-001@...`, asset tag `LT-<run-id>-000001`). Before that,
 * two runs shared one name space: a second run overwrote the first run's
 * accounts and passwords, and `--delete` removed whichever rows happened to
 * match — possibly another run's, possibly while it was still running.
 * `--delete` now refuses to touch rows that do not carry the given run id.
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

/**
 * The run id is embedded in every row this script creates, so one run's data
 * can never be confused with another's. Restricted to characters that are safe
 * in an email local part and an asset tag, and long enough to be unique.
 */
function requireRunId(): string {
  const value = process.env.LOADTEST_RUN_ID ?? arg('run-id');
  if (!value) {
    throw new Error(
      '--run-id (or LOADTEST_RUN_ID) is required: fixtures are owned by a run, ' +
        'so one run cannot delete or reuse another run\'s data',
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{7,47}$/.test(value)) {
    throw new Error('--run-id must be 8-48 chars of lowercase letters, digits and hyphens');
  }
  return value;
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function emailFor(runId: string, index: number): string {
  return `${EMAIL_PREFIX}${runId}-${String(index).padStart(3, '0')}@${EMAIL_DOMAIN}`;
}

/** Escapes a run id for use inside a `LIKE` pattern. */
function likeSafe(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

/** Removes every row this run created (assets first — they reference users). */
async function remove(runId: string): Promise<void> {
  const tagPattern = `${TAG_PREFIX}${likeSafe(runId)}-%`;
  const assets = await prisma.$executeRaw`
    DELETE FROM "Asset" WHERE "assetTag" LIKE ${tagPattern}
  `;
  // The exact prefix, so a neighbouring run id is never caught by a wildcard.
  const users = await prisma.user.deleteMany({
    where: {
      AND: [
        { email: { startsWith: `${EMAIL_PREFIX}${runId}-` } },
        { email: { endsWith: `@${EMAIL_DOMAIN}` } },
      ],
    },
  });
  console.log(
    `removed ${assets} load-test asset(s) and ${users.count} account(s) owned by run ${runId}`,
  );
}

/** Refuses to run when this run id already owns rows, so a rerun is deliberate. */
async function assertNotAlreadySeeded(runId: string): Promise<void> {
  const existing = await prisma.user.count({
    where: { email: { startsWith: `${EMAIL_PREFIX}${runId}-` } },
  });
  if (existing > 0) {
    throw new Error(
      `run ${runId} already owns ${existing} account(s): delete them first with ` +
        `--run-id ${runId} --delete, or use a new run id`,
    );
  }
}

/**
 * Assets are inserted in SQL: 5,000 of them one `create()` at a time would take
 * longer than the test itself, and the point of them is to make the asset list
 * a realistic query (a sort over a table that does not fit in the CPU cache).
 */
async function seedAssets(runId: string, count: number): Promise<void> {
  const categoryName = `Load test ${runId}`;
  const category = await prisma.assetCategory.upsert({
    where: { name: categoryName },
    update: {},
    create: { name: categoryName },
  });

  await prisma.$executeRaw`
    INSERT INTO "Asset" (
      id, "assetTag", name, "serialNumber", "categoryId",
      status, condition, "isBookable", location, "createdAt", "updatedAt"
    )
    SELECT
      'lt-asset-' || ${runId} || '-' || g,
      ${TAG_PREFIX} || ${runId} || '-' || lpad(g::text, 6, '0'),
      'Load test asset ' || g,
      'LT-SN-' || ${runId} || '-' || g,
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
  console.log(`upserted up to ${count} asset(s) tagged ${TAG_PREFIX}${runId}-NNNNNN`);
}

async function main(): Promise<void> {
  const runId = requireRunId();

  if (flag('delete')) {
    await remove(runId);
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

  await assertNotAlreadySeeded(runId);

  console.warn(
    `creating ${users} account(s) ${EMAIL_PREFIX}${runId}-***@${EMAIL_DOMAIN} — ` +
      `delete them with: npm run seed:loadtest -- --run-id ${runId} --delete`,
  );

  // One hash is enough: every fixture account shares the run's password.
  const passwordHash = password
    ? await hashPassword(password, { rounds: Number(process.env.BCRYPT_ROUNDS ?? 12) })
    : undefined;

  for (let i = 1; i <= users; i++) {
    const email = emailFor(runId, i);
    await prisma.user.upsert({
      where: { email },
      update: passwordHash
        ? { passwordHash, status: RecordStatus.ACTIVE }
        : { status: RecordStatus.ACTIVE },
      create: {
        email,
        name: `Load Test ${runId} ${String(i).padStart(3, '0')}`,
        role: Role.EMPLOYEE,
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
  }
  console.log(`upserted ${users} account(s); the first is ${emailFor(runId, 1)}`);

  if (assets > 0) await seedAssets(runId, assets);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
