import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export interface LogParams {
  actorId?: string | null;
  action: string; // e.g. "asset.allocated", "maintenance.approved"
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append-only "who did what, when" log. Every feature calls `log()` after a
 * meaningful state change. Rows are only ever inserted, never updated/deleted.
 * Exposed globally (see ActivityModule) so any service can inject it.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `client` lets the caller pass a transaction client so the log row is
   * written inside the same transaction (and on the same pooled connection).
   */
  async log(
    params: LogParams,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await client.activityLog.create({
      data: {
        actorId: params.actorId ?? null,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        metadata: params.metadata,
      },
    });
  }

  /** Paginated feed, newest first. Optionally filter by entity or actor. */
  async list(params: {
    take?: number;
    skip?: number;
    entityType?: string;
    entityId?: string;
    actorId?: string;
  }) {
    const { take = 50, skip = 0, entityType, entityId, actorId } = params;
    const where: Prisma.ActivityLogWhereInput = {
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(actorId ? { actorId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(take, 200),
        skip,
        include: { actor: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return { items, total };
  }
}
