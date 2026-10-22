import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AllocationStatus,
  AssetStatus,
  MaintenanceStatus,
  NotificationType,
  Prisma,
  Role,
} from '@prisma/client';

import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { maintenanceScope } from '../common/auth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/jwt.strategy';
import { AssignMaintenanceDto } from './dto/assign-maintenance.dto';
import { CreateMaintenanceDto } from './dto/create-maintenance.dto';
import { ListMaintenanceDto } from './dto/list-maintenance.dto';
import { ResolveMaintenanceDto } from './dto/resolve-maintenance.dto';

/** Only these fields of a user are ever exposed on a maintenance request. */
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  departmentId: true,
} as const;

/** Asset statuses that mean "this asset is out of service". */
const OUT_OF_SERVICE: AssetStatus[] = [
  AssetStatus.RETIRED,
  AssetStatus.DISPOSED,
  AssetStatus.LOST,
];

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Raise a repair request (any authenticated user). Starts in PENDING. */
  async create(user: AuthUser, dto: CreateMaintenanceDto) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: dto.assetId },
    });
    if (!asset) throw new NotFoundException('Asset not found');

    // Retired / disposed / lost assets are out of service — there is nothing
    // to repair, and approving them would resurrect a dead asset.
    if (OUT_OF_SERVICE.includes(asset.status)) {
      throw new BadRequestException(
        `Asset ${asset.assetTag} is out of service (status: ${asset.status}) and cannot be sent for maintenance`,
      );
    }

    const request = await this.prisma.maintenanceRequest.create({
      data: {
        assetId: dto.assetId,
        raisedById: user.id,
        description: dto.description,
        priority: dto.priority ?? undefined,
        photoUrl: dto.photoUrl,
      },
      include: { asset: true, raisedBy: { select: USER_SELECT } },
    });

    await this.activity.log({
      actorId: user.id,
      action: 'maintenance.raised',
      entityType: 'MaintenanceRequest',
      entityId: request.id,
      metadata: { assetId: dto.assetId, priority: request.priority },
    });

    // Inform every asset manager so one of them can triage/approve.
    const managers = await this.prisma.user.findMany({
      where: { role: Role.ASSET_MANAGER, status: 'ACTIVE' },
      select: { id: true },
    });
    await this.notifications.notifyMany(
      managers.map((m) => m.id),
      {
        type: NotificationType.MAINTENANCE_RAISED,
        message: `Maintenance raised for asset ${asset.assetTag}: ${dto.description}`,
        relatedEntityType: 'MaintenanceRequest',
        relatedEntityId: request.id,
      },
    );

    return request;
  }

  /** PENDING → APPROVED, and flip the asset into UNDER_MAINTENANCE. */
  async approve(user: AuthUser, id: string) {
    const request = await this.findOrThrow(id);
    if (request.status !== MaintenanceStatus.PENDING) {
      throw new ConflictException(
        `Cannot approve a request in status ${request.status}`,
      );
    }

    // Never send an out-of-service asset "under maintenance" — that would
    // resurrect a retired / disposed / lost asset.
    const asset = await this.prisma.asset.findUnique({
      where: { id: request.assetId },
      select: { id: true, status: true, assetTag: true },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (OUT_OF_SERVICE.includes(asset.status)) {
      throw new ConflictException(
        `Asset ${asset.assetTag} is out of service (status: ${asset.status}) and cannot go under maintenance`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const req = await tx.maintenanceRequest.update({
        where: { id },
        data: {
          status: MaintenanceStatus.APPROVED,
          approvedById: user.id,
        },
        include: { asset: true, raisedBy: { select: USER_SELECT } },
      });
      await tx.asset.update({
        where: { id: req.assetId },
        data: { status: AssetStatus.UNDER_MAINTENANCE },
      });
      return req;
    });

    await this.activity.log({
      actorId: user.id,
      action: 'maintenance.approved',
      entityType: 'MaintenanceRequest',
      entityId: id,
      metadata: { assetId: updated.assetId },
    });
    await this.notifications.notify({
      userId: updated.raisedById,
      type: NotificationType.MAINTENANCE_APPROVED,
      message: `Your maintenance request for ${updated.asset.assetTag} was approved`,
      relatedEntityType: 'MaintenanceRequest',
      relatedEntityId: id,
    });

    return updated;
  }

  /** PENDING → REJECTED. Asset status is untouched. */
  async reject(user: AuthUser, id: string) {
    const request = await this.findOrThrow(id);
    if (request.status !== MaintenanceStatus.PENDING) {
      throw new ConflictException(
        `Cannot reject a request in status ${request.status}`,
      );
    }

    const updated = await this.prisma.maintenanceRequest.update({
      where: { id },
      data: {
        status: MaintenanceStatus.REJECTED,
        approvedById: user.id,
      },
      include: { asset: true, raisedBy: { select: USER_SELECT } },
    });

    await this.activity.log({
      actorId: user.id,
      action: 'maintenance.rejected',
      entityType: 'MaintenanceRequest',
      entityId: id,
      metadata: { assetId: updated.assetId },
    });
    await this.notifications.notify({
      userId: updated.raisedById,
      type: NotificationType.MAINTENANCE_REJECTED,
      message: `Your maintenance request for ${updated.asset.assetTag} was rejected`,
      relatedEntityType: 'MaintenanceRequest',
      relatedEntityId: id,
    });

    return updated;
  }

  /** APPROVED → TECHNICIAN_ASSIGNED. */
  async assign(user: AuthUser, id: string, dto: AssignMaintenanceDto) {
    const request = await this.findOrThrow(id);
    if (request.status !== MaintenanceStatus.APPROVED) {
      throw new ConflictException(
        `Cannot assign a technician to a request in status ${request.status}`,
      );
    }

    const updated = await this.prisma.maintenanceRequest.update({
      where: { id },
      data: {
        status: MaintenanceStatus.TECHNICIAN_ASSIGNED,
        technicianName: dto.technicianName,
      },
      include: { asset: true, raisedBy: { select: USER_SELECT } },
    });

    await this.activity.log({
      actorId: user.id,
      action: 'maintenance.assigned',
      entityType: 'MaintenanceRequest',
      entityId: id,
      metadata: { technicianName: dto.technicianName },
    });

    return updated;
  }

  /** TECHNICIAN_ASSIGNED → IN_PROGRESS. */
  async start(user: AuthUser, id: string) {
    const request = await this.findOrThrow(id);
    if (request.status !== MaintenanceStatus.TECHNICIAN_ASSIGNED) {
      throw new ConflictException(
        `Cannot start work on a request in status ${request.status}`,
      );
    }

    const updated = await this.prisma.maintenanceRequest.update({
      where: { id },
      data: { status: MaintenanceStatus.IN_PROGRESS },
      include: { asset: true, raisedBy: { select: USER_SELECT } },
    });

    await this.activity.log({
      actorId: user.id,
      action: 'maintenance.started',
      entityType: 'MaintenanceRequest',
      entityId: id,
    });

    return updated;
  }

  /**
   * (IN_PROGRESS | TECHNICIAN_ASSIGNED | APPROVED) → RESOLVED. Returns the
   * asset to AVAILABLE and stamps resolvedAt inside one transaction.
   */
  async resolve(user: AuthUser, id: string, dto: ResolveMaintenanceDto) {
    const request = await this.findOrThrow(id);
    const resolvable: MaintenanceStatus[] = [
      MaintenanceStatus.IN_PROGRESS,
      MaintenanceStatus.TECHNICIAN_ASSIGNED,
      MaintenanceStatus.APPROVED,
    ];
    if (!resolvable.includes(request.status)) {
      throw new ConflictException(
        `Cannot resolve a request in status ${request.status}`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const req = await tx.maintenanceRequest.update({
        where: { id },
        data: {
          status: MaintenanceStatus.RESOLVED,
          resolutionNotes: dto.resolutionNotes,
          resolvedAt: new Date(),
        },
        include: { asset: true, raisedBy: { select: USER_SELECT } },
      });
      // Restore the correct post-maintenance status: if the asset was out on an
      // ACTIVE allocation when it went for repair, it goes back to ALLOCATED —
      // otherwise AVAILABLE. (Prevents desyncing an allocation that's still open.)
      const stillAllocated = await tx.allocation.findFirst({
        where: { assetId: req.assetId, status: AllocationStatus.ACTIVE },
        select: { id: true },
      });
      await tx.asset.update({
        where: { id: req.assetId },
        data: {
          status: stillAllocated
            ? AssetStatus.ALLOCATED
            : AssetStatus.AVAILABLE,
        },
      });
      return req;
    });

    await this.activity.log({
      actorId: user.id,
      action: 'maintenance.resolved',
      entityType: 'MaintenanceRequest',
      entityId: id,
      metadata: { assetId: updated.assetId },
    });
    await this.notifications.notify({
      userId: updated.raisedById,
      type: NotificationType.MAINTENANCE_RESOLVED,
      message: `Your maintenance request for ${updated.asset.assetTag} was resolved`,
      relatedEntityType: 'MaintenanceRequest',
      relatedEntityId: id,
    });

    return updated;
  }

  /** Filterable, paginated list. Returns { items, total }. */
  async list(user: AuthUser, query: ListMaintenanceDto) {
    const take = Math.min(query.take ?? 50, 200);
    const skip = query.skip ?? 0;

    const where: Prisma.MaintenanceRequestWhereInput = {
      // Row-level scope: employees only see their own requests, department
      // heads only their department's, managers see everything.
      ...maintenanceScope(user),
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.status && query.status.length
        ? {
            status: Array.isArray(query.status)
              ? { in: query.status }
              : query.status,
          }
        : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.mine === 'true' ? { raisedById: user.id } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.maintenanceRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { asset: true, raisedBy: { select: USER_SELECT } },
      }),
      this.prisma.maintenanceRequest.count({ where }),
    ]);

    return { items, total };
  }

  /** Single request with asset + raiser — only visible within the caller's scope. */
  async findOne(user: AuthUser, id: string) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id, ...maintenanceScope(user) },
      include: {
        asset: true,
        raisedBy: { select: USER_SELECT },
        approvedBy: { select: USER_SELECT },
      },
    });
    if (!request) throw new NotFoundException('Maintenance request not found');
    return request;
  }

  private async findOrThrow(id: string) {
    const request = await this.prisma.maintenanceRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Maintenance request not found');
    return request;
  }
}
