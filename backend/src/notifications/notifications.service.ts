import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType } from '@prisma/client';

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
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(params: NotifyParams): Promise<void> {
    await this.prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        message: params.message,
        relatedEntityType: params.relatedEntityType,
        relatedEntityId: params.relatedEntityId,
      },
    });
  }

  /** Fan the same notification out to several recipients (de-duplicated). */
  async notifyMany(
    userIds: string[],
    params: Omit<NotifyParams, 'userId'>,
  ): Promise<void> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return;
    await this.prisma.notification.createMany({
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
  async pingAllocation(actorId: string, allocationId: string) {
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
