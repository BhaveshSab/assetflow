import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { ListDepartmentsDto } from './dto/list-departments.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

const HEAD_SELECT = { id: true, name: true } as const;

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** POST /org/departments — ADMIN only. */
  async create(actorId: string, dto: CreateDepartmentDto) {
    const department = await this.prisma.$transaction(async (tx) => {
      const dup = await tx.department.findUnique({
        where: { name: dto.name },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException('A department with this name already exists');
      }

      if (dto.parentDepartmentId) {
        const parent = await tx.department.findUnique({
          where: { id: dto.parentDepartmentId },
          select: { id: true },
        });
        if (!parent) throw new NotFoundException('Parent department not found');
        // A brand-new department has no descendants, so no cycle is possible.
      }

      if (dto.headId) {
        const head = await tx.user.findUnique({
          where: { id: dto.headId },
          select: { id: true },
        });
        if (!head) throw new NotFoundException('Head user not found');
      }

      return tx.department.create({
        data: {
          name: dto.name,
          headId: dto.headId ?? null,
          parentDepartmentId: dto.parentDepartmentId ?? null,
          ...(dto.status ? { status: dto.status } : {}),
        },
        include: {
          head: { select: HEAD_SELECT },
          _count: { select: { members: true, childDepartments: true } },
        },
      });
    });

    await this.activity.log({
      actorId,
      action: 'department.created',
      entityType: 'Department',
      entityId: department.id,
      metadata: { name: department.name },
    });

    return department;
  }

  /** GET /org/departments — any authenticated user. */
  async list(query: ListDepartmentsDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 50, 200);

    const where: Prisma.DepartmentWhereInput = {
      ...(query.q
        ? { name: { contains: query.q, mode: 'insensitive' } }
        : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.department.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          head: { select: HEAD_SELECT },
          parentDepartment: { select: { id: true, name: true } },
          _count: { select: { members: true, childDepartments: true } },
        },
      }),
      this.prisma.department.count({ where }),
    ]);

    return { items, total };
  }

  /** GET /org/departments/:id — any authenticated user. */
  async findOne(id: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        head: { select: HEAD_SELECT },
        parentDepartment: { select: { id: true, name: true } },
        childDepartments: { select: { id: true, name: true, status: true } },
        _count: { select: { members: true, childDepartments: true } },
      },
    });
    if (!department) throw new NotFoundException('Department not found');
    return department;
  }

  /** PATCH /org/departments/:id — ADMIN only. */
  async update(actorId: string, id: string, dto: UpdateDepartmentDto) {
    const department = await this.prisma.$transaction(async (tx) => {
      const current = await tx.department.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Department not found');

      if (dto.name && dto.name !== current.name) {
        const dup = await tx.department.findUnique({
          where: { name: dto.name },
          select: { id: true },
        });
        if (dup) {
          throw new ConflictException(
            'A department with this name already exists',
          );
        }
      }

      if (dto.parentDepartmentId) {
        if (dto.parentDepartmentId === id) {
          throw new BadRequestException('A department cannot be its own parent');
        }
        const parent = await tx.department.findUnique({
          where: { id: dto.parentDepartmentId },
          select: { id: true },
        });
        if (!parent) throw new NotFoundException('Parent department not found');
        await this.assertNoCycle(tx, id, dto.parentDepartmentId);
      }

      if (dto.headId) {
        const head = await tx.user.findUnique({
          where: { id: dto.headId },
          select: { id: true },
        });
        if (!head) throw new NotFoundException('Head user not found');
      }

      const data: Prisma.DepartmentUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.headId !== undefined) {
        data.head = dto.headId
          ? { connect: { id: dto.headId } }
          : { disconnect: true };
      }
      if (dto.parentDepartmentId !== undefined) {
        data.parentDepartment = dto.parentDepartmentId
          ? { connect: { id: dto.parentDepartmentId } }
          : { disconnect: true };
      }

      return tx.department.update({
        where: { id },
        data,
        include: {
          head: { select: HEAD_SELECT },
          parentDepartment: { select: { id: true, name: true } },
          _count: { select: { members: true, childDepartments: true } },
        },
      });
    });

    await this.activity.log({
      actorId,
      action: 'department.updated',
      entityType: 'Department',
      entityId: department.id,
      metadata: { changes: dto as Prisma.InputJsonValue },
    });

    return department;
  }

  /**
   * Walk the ancestor chain of `newParentId`; if we reach `id` the assignment
   * would create a cycle. Runs inside the caller's transaction.
   */
  private async assertNoCycle(
    tx: Prisma.TransactionClient,
    id: string,
    newParentId: string,
  ): Promise<void> {
    let cursor: string | null = newParentId;
    // Bounded by the number of departments to avoid an infinite loop if the
    // existing data already contains a cycle.
    const guardLimit = 10000;
    let steps = 0;
    while (cursor) {
      if (cursor === id) {
        throw new BadRequestException(
          'This parent assignment would create a cycle',
        );
      }
      if (++steps > guardLimit) break;
      const node: { parentDepartmentId: string | null } | null =
        await tx.department.findUnique({
          where: { id: cursor },
          select: { parentDepartmentId: true },
        });
      cursor = node?.parentDepartmentId ?? null;
    }
  }
}
