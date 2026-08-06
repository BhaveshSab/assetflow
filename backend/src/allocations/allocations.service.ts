import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AllocationStatus,
  AssetStatus,
  NotificationType,
  Prisma,
  Role,
  TransferStatus,
} from '@prisma/client';

import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAllocationDto } from './dto/create-allocation.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { QueryAllocationsDto } from './dto/query-allocations.dto';
import { QueryTransfersDto } from './dto/query-transfers.dto';
import { ReturnAllocationDto } from './dto/return-allocation.dto';
import type { AuthUser } from '../auth/jwt.strategy';

/** Never leak passwordHash — the only user shape we ever return/include. */
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  departmentId: true,
} as const;

const MAX_PAGE_SIZE = 200;

@Injectable()
export class AllocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // ALLOCATION
  // -------------------------------------------------------------------------

  /** Allocate an available asset to exactly one holder (user OR department). */
  async allocate(dto: CreateAllocationDto, user: AuthUser) {
    const hasUser = !!dto.holderUserId;
    const hasDept = !!dto.departmentId;
    if (hasUser === hasDept) {
      throw new BadRequestException(
        'Provide exactly one of holderUserId or departmentId',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: dto.assetId } });
      if (!asset) throw new NotFoundException('Asset not found');

      // Lock THIS asset's row for the rest of the transaction so two concurrent
      // allocate() calls for the same asset can't both pass the conflict check
      // (closes the check-then-write race — the second one waits, then sees the
      // ACTIVE allocation the first one created and is rejected).
      await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${dto.assetId} FOR UPDATE`;

      // Validate the target exists before we touch anything.
      if (dto.holderUserId) {
        const holder = await tx.user.findUnique({
          where: { id: dto.holderUserId },
        });
        if (!holder) throw new NotFoundException('Holder user not found');
      }
      if (dto.departmentId) {
        const dept = await tx.department.findUnique({
          where: { id: dto.departmentId },
        });
        if (!dept) throw new NotFoundException('Department not found');
      }

      // CORE CONFLICT RULE: no existing ACTIVE allocation for this asset.
      const existing = await tx.allocation.findFirst({
        where: { assetId: dto.assetId, status: AllocationStatus.ACTIVE },
        include: {
          holderUser: { select: USER_SELECT },
          department: { select: { id: true, name: true } },
        },
      });
      if (existing) {
        const holderName =
          existing.holderUser?.name ??
          existing.department?.name ??
          'another holder';
        throw new ConflictException({
          message: `Asset ${asset.assetTag} is currently held by ${holderName}`,
          currentHolder: existing.holderUser ?? null,
          currentDepartment: existing.department ?? null,
          currentAllocationId: existing.id,
        });
      }

      // Belt-and-braces: the asset must also be flagged AVAILABLE.
      if (asset.status !== AssetStatus.AVAILABLE) {
        throw new ConflictException(
          `Asset ${asset.assetTag} is not available (status: ${asset.status})`,
        );
      }

      const allocation = await tx.allocation.create({
        data: {
          assetId: dto.assetId,
          holderUserId: dto.holderUserId ?? null,
          departmentId: dto.departmentId ?? null,
          allocatedById: user.id,
          expectedReturnDate: dto.expectedReturnDate
            ? new Date(dto.expectedReturnDate)
            : null,
          status: AllocationStatus.ACTIVE,
        },
        include: {
          asset: true,
          holderUser: { select: USER_SELECT },
          department: { select: { id: true, name: true } },
        },
      });

      await tx.asset.update({
        where: { id: dto.assetId },
        data: { status: AssetStatus.ALLOCATED },
      });

      await this.activity.log({
        actorId: user.id,
        action: 'asset.allocated',
        entityType: 'Allocation',
        entityId: allocation.id,
        metadata: {
          assetId: asset.id,
          assetTag: asset.assetTag,
          holderUserId: dto.holderUserId ?? null,
          departmentId: dto.departmentId ?? null,
        },
      });

      if (dto.holderUserId) {
        await this.notifications.notify({
          userId: dto.holderUserId,
          type: NotificationType.ASSET_ASSIGNED,
          message: `Asset ${asset.assetTag} (${asset.name}) has been assigned to you`,
          relatedEntityType: 'Allocation',
          relatedEntityId: allocation.id,
        });
      }

      return allocation;
    });
  }

  /** Check an asset back in — only valid on an ACTIVE allocation. */
  async returnAllocation(
    id: string,
    dto: ReturnAllocationDto,
    user: AuthUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const allocation = await tx.allocation.findUnique({
        where: { id },
        include: { asset: true },
      });
      if (!allocation) throw new NotFoundException('Allocation not found');
      if (allocation.status !== AllocationStatus.ACTIVE) {
        throw new ConflictException(
          'This allocation is not active and cannot be returned',
        );
      }

      // Managers may return any allocation; an employee may only return their
      // own (holderUserId === caller).
      const isManager =
        user.role === Role.ADMIN ||
        user.role === Role.ASSET_MANAGER ||
        user.role === Role.DEPARTMENT_HEAD;
      if (!isManager && allocation.holderUserId !== user.id) {
        throw new ForbiddenException(
          'You can only return an asset that is allocated to you',
        );
      }

      const updated = await tx.allocation.update({
        where: { id },
        data: {
          status: AllocationStatus.RETURNED,
          returnedAt: new Date(),
          checkInNotes: dto.checkInNotes ?? null,
          conditionOnReturn: dto.conditionOnReturn ?? null,
        },
        include: {
          asset: true,
          holderUser: { select: USER_SELECT },
          department: { select: { id: true, name: true } },
        },
      });

      await tx.asset.update({
        where: { id: allocation.assetId },
        data: {
          status: AssetStatus.AVAILABLE,
          ...(dto.conditionOnReturn
            ? { condition: dto.conditionOnReturn }
            : {}),
        },
      });

      await this.activity.log({
        actorId: user.id,
        action: 'asset.returned',
        entityType: 'Allocation',
        entityId: allocation.id,
        metadata: {
          assetId: allocation.assetId,
          assetTag: allocation.asset.assetTag,
          conditionOnReturn: dto.conditionOnReturn ?? null,
        },
      });

      if (allocation.holderUserId) {
        await this.notifications.notify({
          userId: allocation.holderUserId,
          type: NotificationType.ASSET_RETURNED,
          message: `Asset ${allocation.asset.assetTag} (${allocation.asset.name}) has been checked in / returned`,
          relatedEntityType: 'Allocation',
          relatedEntityId: allocation.id,
        });
      }

      return updated;
    });
  }

  /** Paginated allocation list with filters (incl. overdue).
   *  DEPARTMENT_HEAD callers are scoped to allocations that touch their own
   *  department (either held by the department or by a user in it). */
  async list(query: QueryAllocationsDto, user?: AuthUser) {
    const take = Math.min(query.take ?? 50, MAX_PAGE_SIZE);
    const skip = query.skip ?? 0;

    const where: Prisma.AllocationWhereInput = {
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.holderUserId ? { holderUserId: query.holderUserId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      // overdue = ACTIVE AND expectedReturnDate < now.
      ...(query.overdue
        ? {
            status: AllocationStatus.ACTIVE,
            expectedReturnDate: { lt: new Date() },
          }
        : {}),
    };

    // DEPARTMENT_HEAD: only allocations in their own department.
    if (user?.role === Role.DEPARTMENT_HEAD && user.departmentId) {
      where.OR = [
        { departmentId: user.departmentId },
        { holderUser: { departmentId: user.departmentId } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.allocation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          asset: true,
          holderUser: { select: USER_SELECT },
          department: { select: { id: true, name: true } },
        },
      }),
      this.prisma.allocation.count({ where }),
    ]);

    return { items, total };
  }

  /** Overdue allocations — feeds the dashboard + overdue-return notifications.
   *  DEPARTMENT_HEAD callers are scoped to their own department (like list()). */
  async listOverdue(user?: AuthUser) {
    const where: Prisma.AllocationWhereInput = {
      status: AllocationStatus.ACTIVE,
      expectedReturnDate: { lt: new Date() },
    };

    if (user?.role === Role.DEPARTMENT_HEAD && user.departmentId) {
      where.OR = [
        { departmentId: user.departmentId },
        { holderUser: { departmentId: user.departmentId } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.allocation.findMany({
        where,
        orderBy: { expectedReturnDate: 'asc' },
        take: MAX_PAGE_SIZE,
        include: {
          asset: true,
          holderUser: { select: USER_SELECT },
          department: { select: { id: true, name: true } },
        },
      }),
      this.prisma.allocation.count({ where }),
    ]);

    return { items, total };
  }

  /** Get current user's allocations (both active and returned). */
  async listMyAllocations(userId: string) {
    const where: Prisma.AllocationWhereInput = {
      OR: [
        { holderUserId: userId },
        { allocatedById: userId },
      ],
    };

    const [items, total] = await Promise.all([
      this.prisma.allocation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: MAX_PAGE_SIZE,
        include: {
          asset: {
            include: {
              category: { select: { id: true, name: true } },
            },
          },
          holderUser: { select: USER_SELECT },
          department: { select: { id: true, name: true } },
        },
      }),
      this.prisma.allocation.count({ where }),
    ]);

    return { items, total };
  }

  // -------------------------------------------------------------------------
  // TRANSFER WORKFLOW
  // -------------------------------------------------------------------------

  /** Request a transfer of a currently-allocated asset to a new holder. */
  async requestTransfer(dto: CreateTransferDto, user: AuthUser) {
    const hasUser = !!dto.toUserId;
    const hasDept = !!dto.toDepartmentId;
    if (hasUser === hasDept) {
      throw new BadRequestException(
        'Provide exactly one of toUserId or toDepartmentId',
      );
    }

    const asset = await this.prisma.asset.findUnique({
      where: { id: dto.assetId },
    });
    if (!asset) throw new NotFoundException('Asset not found');

    // A transfer only makes sense for an asset someone currently holds.
    const active = await this.prisma.allocation.findFirst({
      where: { assetId: dto.assetId, status: AllocationStatus.ACTIVE },
    });
    if (!active) {
      throw new ConflictException(
        `Asset ${asset.assetTag} is not currently allocated; allocate it first`,
      );
    }

    // Only the current holder (or a manager) may request a transfer. The UI
    // hides this for employees, but the API must enforce it too.
    const isManager =
      user.role === Role.ADMIN ||
      user.role === Role.ASSET_MANAGER ||
      user.role === Role.DEPARTMENT_HEAD;
    if (!isManager && active.holderUserId !== user.id) {
      throw new ForbiddenException(
        'You can only request a transfer for an asset allocated to you',
      );
    }

    if (dto.toUserId) {
      const target = await this.prisma.user.findUnique({
        where: { id: dto.toUserId },
      });
      if (!target) throw new NotFoundException('Target user not found');
    }
    if (dto.toDepartmentId) {
      const target = await this.prisma.department.findUnique({
        where: { id: dto.toDepartmentId },
      });
      if (!target) throw new NotFoundException('Target department not found');
    }

    const transfer = await this.prisma.transferRequest.create({
      data: {
        assetId: dto.assetId,
        requestedById: user.id,
        toUserId: dto.toUserId ?? null,
        toDepartmentId: dto.toDepartmentId ?? null,
        reason: dto.reason ?? null,
        status: TransferStatus.REQUESTED,
      },
      include: {
        asset: true,
        requestedBy: { select: USER_SELECT },
        toUser: { select: USER_SELECT },
        toDepartment: { select: { id: true, name: true } },
      },
    });

    await this.activity.log({
      actorId: user.id,
      action: 'transfer.requested',
      entityType: 'TransferRequest',
      entityId: transfer.id,
      metadata: {
        assetId: asset.id,
        assetTag: asset.assetTag,
        toUserId: dto.toUserId ?? null,
        toDepartmentId: dto.toDepartmentId ?? null,
      },
    });

    // Inform the people who can act on it — the Asset Managers.
    const managers = await this.prisma.user.findMany({
      where: { role: Role.ASSET_MANAGER, status: 'ACTIVE' },
      select: { id: true },
    });
    await this.notifications.notifyMany(
      managers.map((m) => m.id),
      {
        type: NotificationType.TRANSFER_REQUESTED,
        message: `Transfer requested for asset ${asset.assetTag} (${asset.name})`,
        relatedEntityType: 'TransferRequest',
        relatedEntityId: transfer.id,
      },
    );

    return transfer;
  }

  /** True when a transfer touches a department — current holder, target user,
   *  or target department. Non-department managers are never subject to this. */
  private transferTouchesDepartment(
    transfer: {
      toUserId: string | null;
      toDepartmentId: string | null;
      toUser?: { departmentId: string | null } | null;
    },
    active: {
      departmentId: string | null;
      holderUser?: { departmentId: string | null } | null;
    },
    deptId: string | null,
  ): boolean {
    if (!deptId) return false;
    if (transfer.toDepartmentId === deptId) return true;
    if (transfer.toUser?.departmentId === deptId) return true;
    if (active.departmentId === deptId) return true;
    if (active.holderUser?.departmentId === deptId) return true;
    return false;
  }

  /** Approve a REQUESTED transfer: re-allocate the asset to the new holder.
   *  DEPARTMENT_HEAD callers may only act on transfers in their own department. */
  async approveTransfer(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.transferRequest.findUnique({
        where: { id },
        include: {
          asset: true,
          toUser: { select: USER_SELECT },
        },
      });
      if (!transfer) throw new NotFoundException('Transfer request not found');
      if (transfer.status !== TransferStatus.REQUESTED) {
        throw new ConflictException(
          `Transfer request is already ${transfer.status}`,
        );
      }

      // Lock the asset row so a concurrent allocate/transfer can't interleave.
      await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${transfer.assetId} FOR UPDATE`;

      // Close out the asset's current holder.
      const active = await tx.allocation.findFirst({
        where: {
          assetId: transfer.assetId,
          status: AllocationStatus.ACTIVE,
        },
        include: { holderUser: { select: USER_SELECT } },
      });
      if (!active) {
        throw new ConflictException(
          'Asset no longer has an active allocation to transfer',
        );
      }

      // DEPARTMENT_HEAD may only approve transfers touching their own department.
      if (user.role === Role.DEPARTMENT_HEAD) {
        const touches =
          this.transferTouchesDepartment(transfer, active, user.departmentId);
        if (!touches) {
          throw new ForbiddenException(
            'You can only approve transfers that involve your department',
          );
        }
      }

      await tx.allocation.update({
        where: { id: active.id },
        data: {
          status: AllocationStatus.RETURNED,
          returnedAt: new Date(),
          checkInNotes: `Transferred via request ${transfer.id}`,
        },
      });

      // Open the new allocation to the transfer target.
      const newAllocation = await tx.allocation.create({
        data: {
          assetId: transfer.assetId,
          holderUserId: transfer.toUserId ?? null,
          departmentId: transfer.toDepartmentId ?? null,
          allocatedById: user.id,
          status: AllocationStatus.ACTIVE,
        },
      });

      // Asset stays ALLOCATED — it just changed hands.
      await tx.asset.update({
        where: { id: transfer.assetId },
        data: { status: AssetStatus.ALLOCATED },
      });

      const resolved = await tx.transferRequest.update({
        where: { id },
        data: {
          status: TransferStatus.COMPLETED,
          approvedById: user.id,
          resolvedAt: new Date(),
        },
        include: {
          asset: true,
          requestedBy: { select: USER_SELECT },
          toUser: { select: USER_SELECT },
          toDepartment: { select: { id: true, name: true } },
        },
      });

      await this.activity.log({
        actorId: user.id,
        action: 'transfer.approved',
        entityType: 'TransferRequest',
        entityId: transfer.id,
        metadata: {
          assetId: transfer.assetId,
          assetTag: transfer.asset.assetTag,
          previousAllocationId: active.id,
          newAllocationId: newAllocation.id,
          toUserId: transfer.toUserId ?? null,
          toDepartmentId: transfer.toDepartmentId ?? null,
        },
      });

      // Tell the requester it went through.
      await this.notifications.notify({
        userId: transfer.requestedById,
        type: NotificationType.TRANSFER_APPROVED,
        message: `Your transfer request for asset ${transfer.asset.assetTag} was approved`,
        relatedEntityType: 'TransferRequest',
        relatedEntityId: transfer.id,
      });

      // Tell the new holder they now have the asset.
      if (transfer.toUserId) {
        await this.notifications.notify({
          userId: transfer.toUserId,
          type: NotificationType.ASSET_ASSIGNED,
          message: `Asset ${transfer.asset.assetTag} (${transfer.asset.name}) has been assigned to you`,
          relatedEntityType: 'Allocation',
          relatedEntityId: newAllocation.id,
        });
      }

      return resolved;
    });
  }

  /** Reject a REQUESTED transfer — no re-allocation happens.
   *  DEPARTMENT_HEAD callers may only act on transfers in their own department. */
  async rejectTransfer(id: string, user: AuthUser) {
    const transfer = await this.prisma.transferRequest.findUnique({
      where: { id },
      include: {
        asset: true,
        toUser: { select: USER_SELECT },
      },
    });
    if (!transfer) throw new NotFoundException('Transfer request not found');
    if (transfer.status !== TransferStatus.REQUESTED) {
      throw new ConflictException(
        `Transfer request is already ${transfer.status}`,
      );
    }

    // DEPARTMENT_HEAD may only reject transfers touching their own department.
    if (user.role === Role.DEPARTMENT_HEAD) {
      const active = await this.prisma.allocation.findFirst({
        where: {
          assetId: transfer.assetId,
          status: AllocationStatus.ACTIVE,
        },
        include: { holderUser: { select: USER_SELECT } },
      });
      const touches = this.transferTouchesDepartment(
        transfer,
        active ?? { departmentId: null, holderUser: null },
        user.departmentId,
      );
      if (!touches) {
        throw new ForbiddenException(
          'You can only reject transfers that involve your department',
        );
      }
    }

    const resolved = await this.prisma.transferRequest.update({
      where: { id },
      data: {
        status: TransferStatus.REJECTED,
        approvedById: user.id,
        resolvedAt: new Date(),
      },
      include: {
        asset: true,
        requestedBy: { select: USER_SELECT },
        toUser: { select: USER_SELECT },
        toDepartment: { select: { id: true, name: true } },
      },
    });

    await this.activity.log({
      actorId: user.id,
      action: 'transfer.rejected',
      entityType: 'TransferRequest',
      entityId: transfer.id,
      metadata: {
        assetId: transfer.assetId,
        assetTag: transfer.asset.assetTag,
      },
    });

    await this.notifications.notify({
      userId: transfer.requestedById,
      type: NotificationType.TRANSFER_REJECTED,
      message: `Your transfer request for asset ${transfer.asset.assetTag} was rejected`,
      relatedEntityType: 'TransferRequest',
      relatedEntityId: transfer.id,
    });

    return resolved;
  }

  /** Paginated transfer list with filters.
   *  DEPARTMENT_HEAD callers only see transfers touching their own department. */
  async listTransfers(query: QueryTransfersDto, user?: AuthUser) {
    const take = Math.min(query.take ?? 50, MAX_PAGE_SIZE);
    const skip = query.skip ?? 0;

    const where: Prisma.TransferRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.assetId ? { assetId: query.assetId } : {}),
    };

    if (user?.role === Role.DEPARTMENT_HEAD && user.departmentId) {
      where.OR = [
        { toDepartmentId: user.departmentId },
        { toUser: { departmentId: user.departmentId } },
        {
          asset: {
            allocations: {
              some: {
                status: AllocationStatus.ACTIVE,
                OR: [
                  { departmentId: user.departmentId },
                  { holderUser: { departmentId: user.departmentId } },
                ],
              },
            },
          },
        },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.transferRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          asset: true,
          requestedBy: { select: USER_SELECT },
          toUser: { select: USER_SELECT },
          toDepartment: { select: { id: true, name: true } },
        },
      }),
      this.prisma.transferRequest.count({ where }),
    ]);

    return { items, total };
  }
}
