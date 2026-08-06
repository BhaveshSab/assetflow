import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { ListEmployeesDto } from './dto/list-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { UpdateEmployeeRoleDto } from './dto/update-employee-role.dto';

/** Public-safe user projection — never includes passwordHash. */
const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
} as const;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /** GET /org/employees — ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD. */
  async list(query: ListEmployeesDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 50, 200);

    const where: Prisma.UserWhereInput = {
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: EMPLOYEE_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total };
  }

  /** GET /org/employees/directory — any authenticated user.
   *  Minimal, safe projection (no roles/status) so employees can pick a
   *  transfer target without seeing privileged directory data. */
  async listDirectory() {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        department: { select: { name: true } },
      },
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      department: u.department?.name ?? null,
    }));
  }

  /** POST /org/employees — ADMIN. Provision an account directly. */
  async create(actorId: string, dto: CreateEmployeeDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Email already registered');

    if (dto.departmentId) {
      const dept = await this.prisma.department.findUnique({
        where: { id: dto.departmentId },
        select: { id: true },
      });
      if (!dept) throw new NotFoundException('Department not found');
    }

    const passwordHash = await bcrypt.hash(dto.password ?? 'password123', 10);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash,
        role: dto.role ?? Role.EMPLOYEE,
        ...(dto.departmentId ? { departmentId: dto.departmentId } : {}),
      },
      select: EMPLOYEE_SELECT,
    });

    await this.activity.log({
      actorId,
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      metadata: { role: user.role, email: user.email },
    });

    return user;
  }

  /** GET /org/employees/:id — ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD. */
  async findOne(id: string) {
    const employee = await this.prisma.user.findUnique({
      where: { id },
      select: EMPLOYEE_SELECT,
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /** PATCH /org/employees/:id — ADMIN only. Never changes role. */
  async update(actorId: string, id: string, dto: UpdateEmployeeDto) {
    const employee = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true },
      });
      if (!current) throw new NotFoundException('Employee not found');

      // Same last-admin protection as updateRole(): deactivating the sole active
      // ADMIN would lock everyone out (JwtStrategy rejects INACTIVE users).
      if (dto.status === 'INACTIVE' && current.role === Role.ADMIN) {
        const activeAdmins = await tx.user.count({
          where: { role: Role.ADMIN, status: 'ACTIVE' },
        });
        if (activeAdmins <= 1) {
          throw new ConflictException(
            'Cannot deactivate the last remaining active admin',
          );
        }
      }

      if (dto.departmentId) {
        const dept = await tx.department.findUnique({
          where: { id: dto.departmentId },
          select: { id: true },
        });
        if (!dept) throw new NotFoundException('Department not found');
      }

      const data: Prisma.UserUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.departmentId !== undefined) {
        data.department = dto.departmentId
          ? { connect: { id: dto.departmentId } }
          : { disconnect: true };
      }

      return tx.user.update({
        where: { id },
        data,
        select: EMPLOYEE_SELECT,
      });
    });

    await this.activity.log({
      actorId,
      action: 'user.updated',
      entityType: 'User',
      entityId: employee.id,
      metadata: { changes: dto as Prisma.InputJsonValue },
    });

    return employee;
  }

  /**
   * PATCH /org/employees/:id/role — ADMIN ONLY.
   * The single place a user's role is ever changed. Guards against demoting the
   * last remaining active ADMIN into lockout.
   */
  async updateRole(actorId: string, id: string, dto: UpdateEmployeeRoleDto) {
    const { employee, previousRole } = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.user.findUnique({
          where: { id },
          select: { id: true, role: true },
        });
        if (!current) throw new NotFoundException('Employee not found');

        // Demoting an ADMIN away from ADMIN: block if they are the last active one.
        if (current.role === Role.ADMIN && dto.role !== Role.ADMIN) {
          const activeAdmins = await tx.user.count({
            where: { role: Role.ADMIN, status: 'ACTIVE' },
          });
          if (activeAdmins <= 1) {
            throw new ConflictException(
              'Cannot change the role of the last remaining admin',
            );
          }
        }

        const updated = await tx.user.update({
          where: { id },
          data: { role: dto.role },
          select: EMPLOYEE_SELECT,
        });
        return { employee: updated, previousRole: current.role };
      },
    );

    await this.activity.log({
      actorId,
      action: 'user.role_changed',
      entityType: 'User',
      entityId: employee.id,
      metadata: { from: previousRole, to: dto.role },
    });

    // Inform the affected user their role changed.
    await this.notifications.notify({
      userId: employee.id,
      type: NotificationType.USER_ROLE_CHANGED,
      message: `Your role has been changed to ${dto.role}.`,
      relatedEntityType: 'User',
      relatedEntityId: employee.id,
    });

    return employee;
  }
}
