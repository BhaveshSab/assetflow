/**
 * Promote (or demote) an existing account, from the command line.
 *
 *   npm run promote -- someone@example.com ADMIN
 *   npm run promote -- someone@example.com ASSET_MANAGER
 *   npm run promote -- someone@example.com EMPLOYEE
 *
 * Why a script and not an endpoint: the only endpoint that can change a role
 * is `PATCH /employees/:id/role`, which an Admin must call — useless when the
 * database has no admin yet. This runs with the database credentials the
 * server already has, so it is exactly as privileged as the server itself.
 *
 * It never creates an account. A typo in the address fails loudly instead of
 * silently minting a user with no password.
 *
 * Safety rules, all of which the API also enforces for the same change:
 *   * the address must already exist;
 *   * a deactivated account is refused (activate it first — otherwise the
 *     promotion hands out a role nobody can use);
 *   * the last active administrator cannot be demoted, because that would
 *     lock the whole deployment out of employee and role management.
 */
import { PrismaClient, RecordStatus, Role } from '@prisma/client';

const prisma = new PrismaClient();

const ROLES = Object.values(Role);

function usage(): never {
  console.error(
    [
      'Usage: npm run promote -- <email> <role>',
      '',
      `  role: ${ROLES.join(' | ')}`,
      '',
      'Example: npm run promote -- ada@example.com ADMIN',
    ].join('\n'),
  );
  process.exit(1);
}

async function main() {
  const [emailArg, roleArg] = process.argv.slice(2);
  if (!emailArg || !roleArg) usage();

  const email = emailArg.trim().toLowerCase();
  const role = roleArg.trim().toUpperCase() as Role;

  if (!ROLES.includes(role)) {
    console.error(`"${roleArg}" is not a role. Expected one of: ${ROLES.join(', ')}`);
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  if (!user) {
    console.error(
      `No account with the address ${email}. Create it first (sign up in the app), then run this again — this script never creates users.`,
    );
    process.exit(1);
  }

  if (user.status !== RecordStatus.ACTIVE) {
    console.error(
      `${user.email} is ${user.status}. Activate the account in the Employees page (or set status ACTIVE) and run this again.`,
    );
    process.exit(1);
  }

  if (user.role === role) {
    console.log(`${user.email} is already ${role}. Nothing to do.`);
    return;
  }

  // Demoting the only active admin would leave nobody able to promote anyone.
  if (
    user.role === Role.ADMIN &&
    role !== Role.ADMIN
  ) {
    const otherAdmins = await prisma.user.count({
      where: {
        role: Role.ADMIN,
        status: RecordStatus.ACTIVE,
        id: { not: user.id },
      },
    });
    if (otherAdmins === 0) {
      console.error(
        `${user.email} is the last active administrator. Promote someone else first, then demote this account — otherwise nobody could manage the deployment.`,
      );
      process.exit(1);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { role } });
    await tx.activityLog.create({
      data: {
        actorId: null, // no signed-in user: this came from the CLI
        action: 'user.role_changed',
        entityType: 'User',
        entityId: user.id,
        metadata: { from: user.role, to: role, source: 'cli' },
      },
    });
  });

  console.log(`${user.email}: ${user.role} → ${role}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
