import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetCondition,
  AssetStatus,
  AuditCycleStatus,
  AuditResult,
  NotificationType,
  Prisma,
  Role,
} from '@prisma/client';

import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/jwt.strategy';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssignAuditorsDto } from './dto/assign-auditors.dto';
import { CreateAuditDto } from './dto/create-audit.dto';
import { MarkAuditItemDto } from './dto/mark-audit-item.dto';

/** Public-safe user selection — never leaks passwordHash. */
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  departmentId: true,
} as const;

/** Lightweight asset selection for item / discrepancy listings. */
const ASSET_SELECT = {
  id: true,
  assetTag: true,
  name: true,
  serialNumber: true,
  location: true,
  status: true,
  condition: true,
} as const;

/** Zeroed result tally used when building per-cycle counts. */
type ResultCounts = {
  total: number;
  pending: number;
  verified: number;
  missing: number;
  damaged: number;
};

@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE CYCLE + auto-generate items
  // -------------------------------------------------------------------------

  async createCycle(user: AuthUser, dto: CreateAuditDto) {
    // Build the "in scope" asset filter (union of location and department).
    // - scopeLocation → asset.location === scopeLocation
    // - scopeDepartmentId → asset has an ACTIVE Allocation whose department is
    //   that department OR whose holderUser belongs to that department
    // - both → union (OR of the two)
    // - neither → ALL assets
    const orConditions: Prisma.AssetWhereInput[] = [];
    if (dto.scopeLocation) {
      orConditions.push({ location: dto.scopeLocation });
    }
    if (dto.scopeDepartmentId) {
      orConditions.push({
        allocations: {
          some: {
            status: 'ACTIVE',
            OR: [
              { departmentId: dto.scopeDepartmentId },
              { holderUser: { departmentId: dto.scopeDepartmentId } },
            ],
          },
        },
      });
    }
    const assetWhere: Prisma.AssetWhereInput =
      orConditions.length > 0 ? { OR: orConditions } : {};

    const cycle = await this.prisma.$transaction(async (tx) => {
      const created = await tx.auditCycle.create({
        data: {
          name: dto.name,
          status: AuditCycleStatus.OPEN,
          scopeDepartmentId: dto.scopeDepartmentId ?? null,
          scopeLocation: dto.scopeLocation ?? null,
          startDate: new Date(dto.startDate),
          endDate: new Date(dto.endDate),
          createdById: user.id,
        },
      });

      const assets = await tx.asset.findMany({
        where: assetWhere,
        select: { id: true },
      });

      if (assets.length > 0) {
        await tx.auditItem.createMany({
          data: assets.map((a) => ({
            auditCycleId: created.id,
            assetId: a.id,
            result: AuditResult.PENDING,
          })),
          skipDuplicates: true,
        });
      }

      return { cycle: created, itemCount: assets.length };
    });

    await this.activity.log({
      actorId: user.id,
      action: 'audit.created',
      entityType: 'AuditCycle',
      entityId: cycle.cycle.id,
      metadata: {
        name: dto.name,
        scopeDepartmentId: dto.scopeDepartmentId ?? null,
        scopeLocation: dto.scopeLocation ?? null,
        itemCount: cycle.itemCount,
      },
    });

    return { ...cycle.cycle, itemCount: cycle.itemCount };
  }

  // -------------------------------------------------------------------------
  // ASSIGN AUDITORS
  // -------------------------------------------------------------------------

  async assignAuditors(user: AuthUser, id: string, dto: AssignAuditorsDto) {
    const cycle = await this.prisma.auditCycle.findUnique({ where: { id } });
    if (!cycle) throw new NotFoundException('Audit cycle not found');

    const auditorIds = [...new Set(dto.auditorIds.filter(Boolean))];

    // Only assign to users that actually exist (avoids FK errors on bad ids).
    const existing = await this.prisma.user.findMany({
      where: { id: { in: auditorIds } },
      select: { id: true },
    });
    const validIds = existing.map((u) => u.id);

    if (validIds.length > 0) {
      await this.prisma.auditAssignment.createMany({
        data: validIds.map((auditorId) => ({
          auditCycleId: id,
          auditorId,
        })),
        skipDuplicates: true, // unique per cycle+auditor → ignore duplicates
      });

      await this.notifications.notifyMany(validIds, {
        type: NotificationType.AUDIT_ASSIGNED,
        message: `You have been assigned as an auditor for audit cycle "${cycle.name}".`,
        relatedEntityType: 'AuditCycle',
        relatedEntityId: id,
      });
    }

    await this.activity.log({
      actorId: user.id,
      action: 'audit.auditors_assigned',
      entityType: 'AuditCycle',
      entityId: id,
      metadata: { auditorIds: validIds },
    });

    return this.getDetail(id);
  }

  // -------------------------------------------------------------------------
  // LIST CYCLES (with counts)
  // -------------------------------------------------------------------------

  async listCycles(params: { status?: string; take?: number; skip?: number }) {
    const take = Math.min(params.take ?? 50, 200);
    const skip = params.skip ?? 0;

    const where: Prisma.AuditCycleWhereInput = {};
    if (
      params.status &&
      (Object.values(AuditCycleStatus) as string[]).includes(params.status)
    ) {
      where.status = params.status as AuditCycleStatus;
    }

    const [cycles, total] = await Promise.all([
      this.prisma.auditCycle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          createdBy: { select: USER_SELECT },
          scopeDepartment: { select: { id: true, name: true } },
        },
      }),
      this.prisma.auditCycle.count({ where }),
    ]);

    const countsByCycle = await this.countsByCycle(cycles.map((c) => c.id));

    const items = cycles.map((c) => ({
      ...c,
      counts: countsByCycle[c.id] ?? this.emptyCounts(),
    }));

    return { items, total };
  }

  // -------------------------------------------------------------------------
  // CYCLE DETAIL
  // -------------------------------------------------------------------------

  async getDetail(id: string) {
    const cycle = await this.prisma.auditCycle.findUnique({
      where: { id },
      include: {
        createdBy: { select: USER_SELECT },
        scopeDepartment: { select: { id: true, name: true } },
        assignments: {
          include: { auditor: { select: USER_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!cycle) throw new NotFoundException('Audit cycle not found');

    const counts = (await this.countsByCycle([id]))[id] ?? this.emptyCounts();

    return {
      ...cycle,
      auditors: cycle.assignments.map((a) => a.auditor),
      counts,
    };
  }

  // -------------------------------------------------------------------------
  // LIST ITEMS (assigned auditor or ADMIN/ASSET_MANAGER)
  // -------------------------------------------------------------------------

  async listItems(
    user: AuthUser,
    id: string,
    params: { take?: number; skip?: number },
  ) {
    await this.assertCycleExists(id);
    await this.assertCanViewItems(user, id);

    const take = Math.min(params.take ?? 50, 200);
    const skip = params.skip ?? 0;
    const where: Prisma.AuditItemWhereInput = { auditCycleId: id };

    const [items, total] = await Promise.all([
      this.prisma.auditItem.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take,
        skip,
        include: {
          asset: { select: ASSET_SELECT },
          auditedBy: { select: USER_SELECT },
        },
      }),
      this.prisma.auditItem.count({ where }),
    ]);

    return { items, total };
  }

  // -------------------------------------------------------------------------
  // MARK ITEM
  // -------------------------------------------------------------------------

  async markItem(
    user: AuthUser,
    id: string,
    itemId: string,
    dto: MarkAuditItemDto,
  ) {
    if (dto.result === AuditResult.PENDING) {
      throw new BadRequestException(
        'result must be one of VERIFIED, MISSING or DAMAGED',
      );
    }

    // Only an auditor assigned to this cycle, or an ADMIN/ASSET_MANAGER, may mark.
    await this.assertCanMark(user, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const cycle = await tx.auditCycle.findUnique({ where: { id } });
      if (!cycle) throw new NotFoundException('Audit cycle not found');
      if (cycle.status === AuditCycleStatus.CLOSED) {
        throw new ConflictException(
          'This audit cycle is closed and can no longer be marked',
        );
      }

      const item = await tx.auditItem.findUnique({ where: { id: itemId } });
      if (!item || item.auditCycleId !== id) {
        throw new NotFoundException('Audit item not found in this cycle');
      }

      return tx.auditItem.update({
        where: { id: itemId },
        data: {
          result: dto.result,
          notes: dto.notes ?? null,
          auditedById: user.id,
          auditedAt: new Date(),
        },
        include: { asset: { select: ASSET_SELECT } },
      });
    });

    await this.activity.log({
      actorId: user.id,
      action: 'audit.item_marked',
      entityType: 'AuditItem',
      entityId: itemId,
      metadata: {
        auditCycleId: id,
        assetId: updated.assetId,
        result: dto.result,
      },
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // DISCREPANCY REPORT
  // -------------------------------------------------------------------------

  async getDiscrepancies(id: string) {
    await this.assertCycleExists(id);

    const where: Prisma.AuditItemWhereInput = {
      auditCycleId: id,
      result: { in: [AuditResult.MISSING, AuditResult.DAMAGED] },
    };

    const [items, total] = await Promise.all([
      this.prisma.auditItem.findMany({
        where,
        orderBy: { result: 'asc' },
        include: {
          asset: { select: ASSET_SELECT },
          auditedBy: { select: USER_SELECT },
        },
      }),
      this.prisma.auditItem.count({ where }),
    ]);

    return { items, total };
  }

  // -------------------------------------------------------------------------
  // CLOSE CYCLE
  // -------------------------------------------------------------------------

  async close(user: AuthUser, id: string) {
    const summary = await this.prisma.$transaction(async (tx) => {
      const cycle = await tx.auditCycle.findUnique({
        where: { id },
        include: { assignments: { select: { auditorId: true } } },
      });
      if (!cycle) throw new NotFoundException('Audit cycle not found');
      if (cycle.status === AuditCycleStatus.CLOSED) {
        throw new ConflictException('This audit cycle is already closed');
      }

      await tx.auditCycle.update({
        where: { id },
        data: { status: AuditCycleStatus.CLOSED, closedAt: new Date() },
      });

      const flagged = await tx.auditItem.findMany({
        where: {
          auditCycleId: id,
          result: { in: [AuditResult.MISSING, AuditResult.DAMAGED] },
        },
        select: { assetId: true, result: true },
      });

      const missingAssetIds = flagged
        .filter((i) => i.result === AuditResult.MISSING)
        .map((i) => i.assetId);
      const damagedAssetIds = flagged
        .filter((i) => i.result === AuditResult.DAMAGED)
        .map((i) => i.assetId);

      // MISSING → asset LOST.
      if (missingAssetIds.length > 0) {
        await tx.asset.updateMany({
          where: { id: { in: missingAssetIds } },
          data: { status: AssetStatus.LOST },
        });
      }
      // DAMAGED → asset condition DAMAGED.
      if (damagedAssetIds.length > 0) {
        await tx.asset.updateMany({
          where: { id: { in: damagedAssetIds } },
          data: { condition: AssetCondition.DAMAGED },
        });
      }

      return {
        name: cycle.name,
        createdById: cycle.createdById,
        auditorIds: cycle.assignments.map((a) => a.auditorId),
        missingCount: missingAssetIds.length,
        damagedCount: damagedAssetIds.length,
      };
    });

    await this.activity.log({
      actorId: user.id,
      action: 'audit.closed',
      entityType: 'AuditCycle',
      entityId: id,
      metadata: {
        name: summary.name,
        missingCount: summary.missingCount,
        damagedCount: summary.damagedCount,
        assetsMarkedLost: summary.missingCount,
        assetsMarkedDamaged: summary.damagedCount,
      },
    });

    // Inform the cycle creator + all auditors that the cycle is closed.
    const recipients = [
      ...new Set([summary.createdById, ...summary.auditorIds]),
    ];
    await this.notifications.notifyMany(recipients, {
      type: NotificationType.AUDIT_CLOSED,
      message: `Audit cycle "${summary.name}" was closed. ${summary.missingCount} asset(s) marked LOST, ${summary.damagedCount} asset(s) marked DAMAGED.`,
      relatedEntityType: 'AuditCycle',
      relatedEntityId: id,
    });

    return this.getDetail(id);
  }

  // -------------------------------------------------------------------------
  // HELPERS
  // -------------------------------------------------------------------------

  private emptyCounts(): ResultCounts {
    return { total: 0, pending: 0, verified: 0, missing: 0, damaged: 0 };
  }

  /** Group AuditItems by cycle + result into a per-cycle tally. */
  private async countsByCycle(
    cycleIds: string[],
  ): Promise<Record<string, ResultCounts>> {
    const map: Record<string, ResultCounts> = {};
    if (cycleIds.length === 0) return map;

    const grouped = await this.prisma.auditItem.groupBy({
      by: ['auditCycleId', 'result'],
      where: { auditCycleId: { in: cycleIds } },
      _count: { _all: true },
    });

    for (const row of grouped) {
      const counts = (map[row.auditCycleId] ??= this.emptyCounts());
      const n = row._count._all;
      counts.total += n;
      switch (row.result) {
        case AuditResult.PENDING:
          counts.pending += n;
          break;
        case AuditResult.VERIFIED:
          counts.verified += n;
          break;
        case AuditResult.MISSING:
          counts.missing += n;
          break;
        case AuditResult.DAMAGED:
          counts.damaged += n;
          break;
      }
    }
    return map;
  }

  private async assertCycleExists(id: string): Promise<void> {
    const cycle = await this.prisma.auditCycle.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!cycle) throw new NotFoundException('Audit cycle not found');
  }

  private isManager(user: AuthUser): boolean {
    return user.role === Role.ADMIN || user.role === Role.ASSET_MANAGER;
  }

  private async isAssignedAuditor(
    userId: string,
    cycleId: string,
  ): Promise<boolean> {
    const assignment = await this.prisma.auditAssignment.findUnique({
      where: {
        auditCycleId_auditorId: { auditCycleId: cycleId, auditorId: userId },
      },
      select: { id: true },
    });
    return !!assignment;
  }

  private async assertCanViewItems(
    user: AuthUser,
    cycleId: string,
  ): Promise<void> {
    if (this.isManager(user)) return;
    if (await this.isAssignedAuditor(user.id, cycleId)) return;
    throw new ForbiddenException('You are not assigned to this audit cycle');
  }

  private async assertCanMark(user: AuthUser, cycleId: string): Promise<void> {
    if (this.isManager(user)) return;
    if (await this.isAssignedAuditor(user.id, cycleId)) return;
    throw new ForbiddenException(
      'Only an assigned auditor or a manager may mark audit items',
    );
  }
}
