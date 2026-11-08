import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AllocationStatus,
  AssetStatus,
  MaintenanceStatus,
  Prisma,
} from '@prisma/client';

import { reserveAssetTags } from './asset-tags';
import { AuthUser } from '../auth/jwt.strategy';
import { ActivityService } from '../activity/activity.service';
import { isUniqueViolation } from '../common/prisma/constraint-errors';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

/** Public-safe user shape for holders/allocators (never leaks passwordHash). */
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  departmentId: true,
} satisfies Prisma.UserSelect;

const MAX_TAG_RETRIES = 5;

/** Maintenance states that keep an asset out of the AVAILABLE pool. */
const OPEN_MAINTENANCE_STATUSES: MaintenanceStatus[] = [
  MaintenanceStatus.PENDING,
  MaintenanceStatus.APPROVED,
  MaintenanceStatus.TECHNICIAN_ASSIGNED,
  MaintenanceStatus.IN_PROGRESS,
];

// Statuses owned by the allocation/maintenance workflows — never settable via
// a manual asset edit.
const WORKFLOW_OWNED_STATUSES: AssetStatus[] = [
  AssetStatus.ALLOCATED,
  AssetStatus.UNDER_MAINTENANCE,
  AssetStatus.RESERVED,
];

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async lookup(assetTag: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { assetTag },
      select: { id: true },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    return this.findOne(asset.id);
  }

  /**
   * Register a new asset with an auto-generated, sequential assetTag (AF-0001).
   *
   * Race-safety: each attempt runs in a $transaction that reads the current
   * highest tag, computes the next one, and creates the asset. If two requests
   * race and one hits the unique constraint on `assetTag` (P2002), we retry up
   * to MAX_TAG_RETRIES times, re-reading the max each attempt.
   */
  async create(dto: CreateAssetDto, user: AuthUser) {
    const category = await this.prisma.assetCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) {
      throw new BadRequestException('categoryId does not reference a category');
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_TAG_RETRIES; attempt++) {
      try {
        const asset = await this.prisma.$transaction(async (tx) => {
          const assetTag = await this.nextAssetTag(tx);
          return tx.asset.create({
            data: {
              assetTag,
              name: dto.name,
              categoryId: dto.categoryId,
              serialNumber: dto.serialNumber,
              acquisitionDate: dto.acquisitionDate
                ? new Date(dto.acquisitionDate)
                : undefined,
              acquisitionCost: dto.acquisitionCost,
              condition: dto.condition,
              location: dto.location,
              photoUrl: dto.photoUrl,
              documents: this.toJson(dto.documents),
              isBookable: dto.isBookable,
              customFieldValues: this.toJson(dto.customFieldValues),
              // status defaults to AVAILABLE via the schema.
            },
            include: { category: { select: { id: true, name: true } } },
          });
        });

        await this.activity.log({
          actorId: user.id,
          action: 'asset.registered',
          entityType: 'Asset',
          entityId: asset.id,
          metadata: { assetTag: asset.assetTag, name: asset.name },
        });

        return asset;
      } catch (err) {
        // Retry only on a unique-constraint clash. Duck-typed on the error
        // shape rather than `instanceof Prisma.PrismaClientKnownRequestError`:
        // with a driver adapter the error class can come from a different
        // module instance, and `instanceof` then quietly returns false — which
        // turned a retryable collision into a 500.
        if (isUniqueViolation(err, ['assetTag', 'Asset_assetTag_key'])) {
          lastError = err;
          // Small randomised pause so retries of a burst do not stay in lockstep.
          await new Promise((resolve) =>
            setTimeout(resolve, 5 + Math.floor(Math.random() * 20)),
          );
          continue;
        }
        throw err;
      }
    }

    // Exhausting the budget is a transient capacity problem, not a bad request:
    // say so honestly instead of throwing a bare Error (which the filter turns
    // into a 500 carrying a stack trace).
    throw new ServiceUnavailableException(
      `Could not allocate an asset tag right now (${MAX_TAG_RETRIES} attempts collided). Please retry. Last error: ${String(
        lastError,
      )}`,
    );
  }

  /** Search + filter the asset directory. Returns { items, total }. */
  async findAll(query: QueryAssetsDto) {
    const take = Math.min(query.take ?? 50, 200);
    const skip = query.skip ?? 0;

    const and: Prisma.AssetWhereInput[] = [];
    if (query.q) {
      and.push({
        OR: [
          { assetTag: { contains: query.q, mode: 'insensitive' } },
          { serialNumber: { contains: query.q, mode: 'insensitive' } },
          { name: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }
    if (query.categoryId) and.push({ categoryId: query.categoryId });
    if (query.status) and.push({ status: query.status });
    if (query.location) {
      and.push({ location: { contains: query.location, mode: 'insensitive' } });
    }
    if (query.isBookable !== undefined) {
      and.push({ isBookable: query.isBookable });
    }

    const where: Prisma.AssetWhereInput = and.length ? { AND: and } : {};

    const [items, total] = await Promise.all([
      this.prisma.asset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        // A list screen needs the columns it renders, not the whole row. The
        // two JSON blobs (`documents`, `customFieldValues`) are the heaviest
        // fields on an asset and are only ever shown on the detail page, so
        // they are fetched by findOne() and deliberately not here. The nested
        // allocation is trimmed to what a row displays as well.
        select: {
          id: true,
          assetTag: true,
          name: true,
          serialNumber: true,
          acquisitionDate: true,
          acquisitionCost: true,
          condition: true,
          location: true,
          photoUrl: true,
          isBookable: true,
          status: true,
          categoryId: true,
          createdAt: true,
          updatedAt: true,
          category: { select: { id: true, name: true } },
          allocations: {
            where: { status: AllocationStatus.ACTIVE },
            take: 1,
            orderBy: { allocatedAt: 'desc' },
            select: {
              id: true,
              status: true,
              allocatedAt: true,
              expectedReturnDate: true,
              holderUser: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  departmentId: true,
                },
              },
              department: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.asset.count({ where }),
    ]);

    // Surface the current holder (if any) as a convenient field.
    const shaped = items.map((asset) => {
      const { allocations, ...rest } = asset;
      const current = allocations[0] ?? null;
      return {
        ...rest,
        currentAllocation: current,
        currentHolder: current?.holderUser ?? null,
      };
    });

    return { items: shaped, total };
  }

  /** Full detail for one asset, including its current ACTIVE allocation. */
  async findOne(id: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true } },
        allocations: {
          where: { status: AllocationStatus.ACTIVE },
          take: 1,
          orderBy: { allocatedAt: 'desc' },
          include: {
            holderUser: { select: USER_SELECT },
            department: { select: { id: true, name: true } },
            allocatedBy: { select: USER_SELECT },
          },
        },
      },
    });
    if (!asset) throw new NotFoundException('Asset not found');

    const { allocations, ...rest } = asset;
    const current = allocations[0] ?? null;
    return {
      ...rest,
      currentAllocation: current,
      currentHolder: current?.holderUser ?? null,
    };
  }

  /**
   * Combined, newest-first history for an asset:
   *  - allocations (holder, who allocated, dates, return info)
   *  - maintenance requests
   */
  async history(id: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');

    const [allocations, maintenance] = await Promise.all([
      this.prisma.allocation.findMany({
        where: { assetId: id },
        orderBy: { allocatedAt: 'desc' },
        include: {
          holderUser: { select: USER_SELECT },
          department: { select: { id: true, name: true } },
          allocatedBy: { select: USER_SELECT },
        },
      }),
      this.prisma.maintenanceRequest.findMany({
        where: { assetId: id },
        orderBy: { createdAt: 'desc' },
        include: {
          raisedBy: { select: USER_SELECT },
          approvedBy: { select: USER_SELECT },
        },
      }),
    ]);

    return { allocations, maintenance };
  }

  /**
   * Edit descriptive fields. `status` may only be set to a terminal/admin
   * state here (RETIRED, DISPOSED, LOST, or back to AVAILABLE). Workflow-owned
   * states (ALLOCATED, UNDER_MAINTENANCE, RESERVED) are rejected with 400.
   */
  async update(id: string, dto: UpdateAssetDto, user: AuthUser) {
    if (dto.status && WORKFLOW_OWNED_STATUSES.includes(dto.status)) {
      throw new BadRequestException(
        `status ${dto.status} is managed by the allocation/maintenance workflows and cannot be set here`,
      );
    }

    if (dto.categoryId) {
      const category = await this.prisma.assetCategory.findUnique({
        where: { id: dto.categoryId },
      });
      if (!category) {
        throw new BadRequestException(
          'categoryId does not reference a category',
        );
      }
    }

    const existing = await this.prisma.asset.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Asset not found');

    // Hand-setting AVAILABLE would desynchronise the asset from its
    // allocations / maintenance requests, so it is only allowed when the
    // asset really is free.
    if (dto.status === AssetStatus.AVAILABLE) {
      const [activeAllocation, openMaintenance] = await Promise.all([
        this.prisma.allocation.findFirst({
          where: { assetId: id, status: AllocationStatus.ACTIVE },
          select: { id: true },
        }),
        this.prisma.maintenanceRequest.findFirst({
          where: { assetId: id, status: { in: OPEN_MAINTENANCE_STATUSES } },
          select: { id: true },
        }),
      ]);
      if (activeAllocation) {
        throw new BadRequestException(
          'This asset is currently allocated — return the allocation before making it available',
        );
      }
      if (openMaintenance) {
        throw new BadRequestException(
          'This asset has an open maintenance request — resolve it before making it available',
        );
      }
    }

    const data: Prisma.AssetUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.serialNumber !== undefined) data.serialNumber = dto.serialNumber;
    if (dto.acquisitionDate !== undefined) {
      data.acquisitionDate = new Date(dto.acquisitionDate);
    }
    if (dto.acquisitionCost !== undefined) {
      data.acquisitionCost = dto.acquisitionCost;
    }
    if (dto.condition !== undefined) data.condition = dto.condition;
    if (dto.location !== undefined) data.location = dto.location;
    if (dto.photoUrl !== undefined) data.photoUrl = dto.photoUrl;
    if (dto.documents !== undefined) {
      data.documents = this.toJson(dto.documents);
    }
    if (dto.isBookable !== undefined) data.isBookable = dto.isBookable;
    if (dto.customFieldValues !== undefined) {
      data.customFieldValues = this.toJson(dto.customFieldValues);
    }
    if (dto.categoryId !== undefined) {
      data.category = { connect: { id: dto.categoryId } };
    }
    if (dto.status !== undefined) data.status = dto.status;

    const asset = await this.prisma.asset.update({
      where: { id },
      data,
      include: { category: { select: { id: true, name: true } } },
    });

    await this.activity.log({
      actorId: user.id,
      action: 'asset.updated',
      entityType: 'Asset',
      entityId: asset.id,
      metadata: {
        assetTag: asset.assetTag,
        changedFields: Object.keys(data),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });

    return asset;
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  /**
   * Compute the next sequential asset tag (AF-0001) inside a transaction.
   *
   * The tag is compared *numerically* (not as a string): a plain
   * `ORDER BY assetTag DESC` sorts "AF-10000" before "AF-9999" and would
   * therefore hand out a duplicate tag as soon as the catalogue passes 9999
   * assets.
   */
  private async nextAssetTag(tx: Prisma.TransactionClient): Promise<string> {
    return (await reserveAssetTags(tx, 1))[0];
  }

  /** Normalise optional Json input for Prisma (undefined stays undefined). */
  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    return value as Prisma.InputJsonValue;
  }
}
