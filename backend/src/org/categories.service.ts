import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ListCategoriesDto } from './dto/list-categories.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** POST /org/categories — ADMIN only. */
  async create(actorId: string, dto: CreateCategoryDto) {
    const category = await this.prisma.$transaction(async (tx) => {
      const dup = await tx.assetCategory.findUnique({
        where: { name: dto.name },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException('A category with this name already exists');
      }

      return tx.assetCategory.create({
        data: {
          name: dto.name,
          ...(dto.customFields !== undefined
            ? { customFields: dto.customFields as Prisma.InputJsonValue }
            : {}),
          ...(dto.status ? { status: dto.status } : {}),
        },
        include: { _count: { select: { assets: true } } },
      });
    });

    await this.activity.log({
      actorId,
      action: 'category.created',
      entityType: 'AssetCategory',
      entityId: category.id,
      metadata: { name: category.name },
    });

    return category;
  }

  /** GET /org/categories — any authenticated user. */
  async list(query: ListCategoriesDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 50, 200);

    const where: Prisma.AssetCategoryWhereInput = {
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.assetCategory.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { assets: true } } },
      }),
      this.prisma.assetCategory.count({ where }),
    ]);

    return { items, total };
  }

  /** GET /org/categories/:id — any authenticated user. */
  async findOne(id: string) {
    const category = await this.prisma.assetCategory.findUnique({
      where: { id },
      include: { _count: { select: { assets: true } } },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  /** PATCH /org/categories/:id — ADMIN only. */
  async update(actorId: string, id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.$transaction(async (tx) => {
      const current = await tx.assetCategory.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Category not found');

      if (dto.name && dto.name !== current.name) {
        const dup = await tx.assetCategory.findUnique({
          where: { name: dto.name },
          select: { id: true },
        });
        if (dup) {
          throw new ConflictException(
            'A category with this name already exists',
          );
        }
      }

      const data: Prisma.AssetCategoryUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.customFields !== undefined) {
        data.customFields = dto.customFields as Prisma.InputJsonValue;
      }

      return tx.assetCategory.update({
        where: { id },
        data,
        include: { _count: { select: { assets: true } } },
      });
    });

    await this.activity.log({
      actorId,
      action: 'category.updated',
      entityType: 'AssetCategory',
      entityId: category.id,
      metadata: { changes: dto as Prisma.InputJsonValue },
    });

    return category;
  }
}
