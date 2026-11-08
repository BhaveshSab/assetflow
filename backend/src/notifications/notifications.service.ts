import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AllocationStatus,
  BookingStatus,
  NotificationType,
  Prisma,
  Role,
} from '@prisma/client';

import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';

export interface NotifyParams {
  userId: string;
  type: NotificationType;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/**
 * Creates in-app notifications. Feature services call `notify()` /
 * `notifyMany()` after events (asset assigned, maintenance approved, etc.).
 * Exposed globally (see NotificationsModule).
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private reminderTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Start the reminder sweeper.
   *
   * Deliberately off under NODE_ENV=test (the suites call sweepReminders()
   * directly, so assertions are deterministic) and switchable off in a
   * deployment with REMINDERS_ENABLED=false.
   */
  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    if (process.env.REMINDERS_ENABLED === 'false') return;
    this.reminderTimer = setInterval(() => {
      void this.sweepReminders().catch(() => undefined);
    }, 60_000);
    this.reminderTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.reminderTimer = null;
  }

  /**
   * The scheduled sweep behind two notification types that had no producer at
   * all — nothing in the codebase ever created them, so the "Booking Reminder"
   * and "Overdue Return Alert" acceptance criteria could not be met:
   *
   *   BOOKING_REMINDER — a booking that starts within the next 30 minutes.
   *   OVERDUE_RETURN   — an ACTIVE allocation whose expected return has passed.
   *
   * Both are idempotent: one notification per (user, type, related entity), so
   * a 60-second sweep cannot spam the same person.
   */
  async sweepReminders(now: Date = new Date()) {
    const soon = new Date(now.getTime() + 30 * 60 * 1000);

    const upcomingBookings =
      process.env.JOBS_ENABLED === 'true'
        ? []
        : await this.prisma.booking.findMany({
            where: {
              status: { not: BookingStatus.CANCELLED },
              startTime: { gt: now, lte: soon },
            },
            include: { asset: { select: { name: true, assetTag: true } } },
            take: 200,
          });

    let bookingReminders = 0;
    for (const booking of upcomingBookings) {
      const already = await this.prisma.notification.findFirst({
        where: {
          userId: booking.bookedById,
          type: NotificationType.BOOKING_REMINDER,
          relatedEntityId: booking.id,
        },
        select: { id: true },
      });
      if (already) continue;

      await this.notify({
        userId: booking.bookedById,
        type: NotificationType.BOOKING_REMINDER,
        message: `Reminder: your booking for ${booking.asset?.name ?? 'a resource'} (${booking.asset?.assetTag ?? '—'}) starts at ${booking.startTime.toISOString()}.`,
        relatedEntityType: 'Booking',
        relatedEntityId: booking.id,
      });
      bookingReminders += 1;
    }

    const overdue = await this.prisma.allocation.findMany({
      where: {
        status: AllocationStatus.ACTIVE,
        expectedReturnDate: { lt: now },
        holderUserId: { not: null },
      },
      include: { asset: { select: { name: true, assetTag: true } } },
      take: 200,
    });

    let overdueAlerts = 0;
    for (const allocation of overdue) {
      if (!allocation.holderUserId) continue;
      const already = await this.prisma.notification.findFirst({
        where: {
          userId: allocation.holderUserId,
          type: NotificationType.OVERDUE_RETURN,
          relatedEntityId: allocation.id,
        },
        select: { id: true },
      });
      if (already) continue;

      await this.notify({
        userId: allocation.holderUserId,
        type: NotificationType.OVERDUE_RETURN,
        message: `Overdue: ${allocation.asset?.name ?? 'an asset'} (${allocation.asset?.assetTag ?? '—'}) was due back on ${allocation.expectedReturnDate?.toISOString().slice(0, 10) ?? 'an earlier date'}.`,
        relatedEntityType: 'Allocation',
        relatedEntityId: allocation.id,
      });
      overdueAlerts += 1;
    }

    return { bookingReminders, overdueAlerts };
  }

  /**
   * AUDIT_DISCREPANCY — broadcast a MISSING/DAMAGED finding to every active
   * ADMIN and ASSET_MANAGER (the auditor who found it excluded). The enum
   * member existed, but nothing ever produced it, so a discrepancy was only
   * visible to whoever happened to open the report.
   */
  async notifyAuditDiscrepancy(params: {
    assetId: string;
    label: string;
    cycleName: string;
    result: string;
    actorId: string;
  }): Promise<number> {
    const recipients = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: [Role.ADMIN, Role.ASSET_MANAGER] },
        id: { not: params.actorId },
      },
      select: { id: true },
    });

    for (const recipient of recipients) {
      await this.notify({
        userId: recipient.id,
        type: NotificationType.AUDIT_DISCREPANCY,
        message: `${params.label} was marked ${params.result} in the audit "${params.cycleName}".`,
        relatedEntityType: 'Asset',
        relatedEntityId: params.assetId,
      });
    }

    return recipients.length;
  }

  /**
   * `client` lets the caller pass a transaction client so the notification is
   * written inside the same transaction (and on the same pooled connection).
   */
  async notify(
    params: NotifyParams,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await client.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        message: params.message,
        relatedEntityType: params.relatedEntityType,
        relatedEntityId: params.relatedEntityId,
      },
      // This event writer does not need the internal reminder deduplication key.
      // An implicit RETURNING * would unnecessarily require that new column.
      select: { id: true },
    });
  }

  /** Fan the same notification out to several recipients (de-duplicated). */
  async notifyMany(
    userIds: string[],
    params: Omit<NotifyParams, 'userId'>,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return;
    await client.notification.createMany({
      data: unique.map((userId) => ({
        userId,
        type: params.type,
        message: params.message,
        relatedEntityType: params.relatedEntityType,
        relatedEntityId: params.relatedEntityId,
      })),
    });
  }

  /** Current user's notifications, newest first. */
  async listForUser(userId: string, onlyUnread = false) {
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, ...(onlyUnread ? { isRead: false } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
        // Keep the public bell independent of worker-only columns (dedupeKey).
        // This also allows reads during an additive migration rollout. Queue
        // workers still require the outbox migration; readiness reports drift.
        select: {
          id: true,
          userId: true,
          type: true,
          message: true,
          isRead: true,
          relatedEntityType: true,
          relatedEntityId: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);
    return { items, unreadCount };
  }

  async markRead(userId: string, id: string): Promise<void> {
    // Scope to userId so users can only mark their own notifications.
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  /**
   * POST /notifications/ping — remind the holder of an allocation (used by the
   * "Send Ping" button on overdue allocations). Creates an OVERDUE_RETURN
   * notification for the holder.
   */
  /**
   * POST /notifications/ping — remind the holder of an allocation (used by the
   * "Send Ping" button on overdue allocations). Creates an OVERDUE_RETURN
   * notification for the holder.
   *
   * Restricted to ADMIN / ASSET_MANAGER — see the controller's @Roles guard.
   */
  async pingAllocation(actor: AuthUser, allocationId: string) {
    const allocation = await this.prisma.allocation.findUnique({
      where: { id: allocationId },
      include: {
        asset: { select: { id: true, name: true, assetTag: true } },
        holderUser: { select: { id: true, name: true } },
      },
    });
    if (!allocation) throw new NotFoundException('Allocation not found');
    if (!allocation.holderUserId) {
      throw new BadRequestException(
        'This allocation is not assigned to a specific user to ping',
      );
    }
    if (allocation.status !== AllocationStatus.ACTIVE) {
      throw new BadRequestException(
        'This allocation is already closed — there is nothing to remind about',
      );
    }
    // A manager must not be able to ping themselves (pointless) — and only
    // *overdue* allocations deserve a reminder.
    if (allocation.holderUserId === actor.id) {
      throw new BadRequestException('You cannot send a reminder to yourself');
    }

    await this.notify({
      userId: allocation.holderUserId,
      type: NotificationType.OVERDUE_RETURN,
      message: `Reminder: please return ${allocation.asset?.name ?? 'your asset'} (${allocation.asset?.assetTag ?? ''}) — the expected return date has passed.`,
      relatedEntityType: 'Allocation',
      relatedEntityId: allocation.id,
    });

    return { success: true, recipient: allocation.holderUser?.name };
  }
}
