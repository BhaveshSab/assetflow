import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecordStatus, Role } from '@prisma/client';

import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How does the **first** administrator exist?
 *
 * Signing up can never grant the Admin role (that is the whole point of the
 * hard-coded `role: EMPLOYEE`), and every admin-only endpoint is behind the
 * Admin role — so a brand-new database would otherwise be impossible to set
 * up: nobody can approve anybody.
 *
 * The answer is a one-way, opt-in promotion that is safe to leave switched on:
 *
 *   1. the person signs up normally (`POST /auth/signup` → EMPLOYEE);
 *   2. the operator sets `BOOTSTRAP_ADMIN_EMAIL=that.address` and restarts;
 *   3. at boot, **if and only if** the database has *no active administrator*,
 *      that existing account is promoted to ADMIN.
 *
 * Three properties make it impossible to use as a back door:
 *
 *  * it never creates a user — the address must already be a real signup,
 *    with a password the operator chose;
 *  * it does nothing while any active admin exists, so re-setting the
 *    variable later cannot hand out a second admin;
 *  * it is driven by a server-side environment variable, not a request, so no
 *    HTTP call can trigger it.
 *
 * For a one-off promotion at any other time (and for local development), use
 * `npm run promote -- someone@example.com ADMIN` — see scripts/promote.ts.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger('AdminBootstrap');

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = (this.config.get<string>('BOOTSTRAP_ADMIN_EMAIL') ?? '')
      .trim()
      .toLowerCase();

    const activeAdmins = await this.prisma.user.count({
      where: { role: Role.ADMIN, status: RecordStatus.ACTIVE },
    });

    if (!email) {
      // Only worth shouting about in a real deployment: without any active
      // admin nobody can approve assets, roles or departments.
      if (activeAdmins === 0 && this.config.get('NODE_ENV') !== 'test') {
        this.logger.warn(
          'No active administrator exists. Sign up, then set BOOTSTRAP_ADMIN_EMAIL to that address and restart, or run: npm run promote -- <email> ADMIN',
        );
      }
      return;
    }

    if (activeAdmins > 0) {
      this.logger.log(
        `BOOTSTRAP_ADMIN_EMAIL is set but ${activeAdmins} active administrator(s) already exist — nothing to do.`,
      );
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, name: true, role: true, status: true },
    });

    if (!user) {
      this.logger.warn(
        `BOOTSTRAP_ADMIN_EMAIL=${email} matches no account. Sign up with that address first, then restart — nothing was created.`,
      );
      return;
    }

    if (user.status === RecordStatus.INACTIVE) {
      this.logger.warn(
        `BOOTSTRAP_ADMIN_EMAIL=${email} matches a deactivated account. Re-activate it as an admin, or use a different address — nothing was changed.`,
      );
      return;
    }

    if (user.role === Role.ADMIN) {
      this.logger.log(`${email} is already an administrator.`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { role: Role.ADMIN },
      });
      await this.activity.log(
        {
          actorId: null,
          action: 'user.role_changed',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            from: user.role,
            to: Role.ADMIN,
            source: 'bootstrap',
          },
        },
        tx,
      );

      // The same notification the Employees page sends when an admin changes
      // a role, so the new admin is not left guessing why the menu changed.
      await tx.notification.create({
        data: {
          userId: user.id,
          type: 'USER_ROLE_CHANGED',
          message:
            'Your account is now an administrator, because this AssetFlow database had no administrator yet. Open Employees to approve the rest of your team.',
        },
      });
    });

    this.logger.warn(
      `Promoted ${email} to ADMIN (bootstrap). Remove BOOTSTRAP_ADMIN_EMAIL from the environment and redeploy — it has done its job.`,
    );
  }
}
