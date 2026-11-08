import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Role, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/jwt.strategy';
import { parseAssetsCsv } from './csv';
import { captureTraceparent } from '../telemetry/tracing';
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}
  async preview(csv: string, user: AuthUser) {
    const { rows, errors } = parseAssetsCsv(csv);
    const categories = await this.prisma.assetCategory.findMany({
      where: {
        id: { in: [...new Set(rows.map((r) => r.categoryId))] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const valid = new Set(categories.map((c) => c.id));
    rows.forEach((r, i) => {
      if (!valid.has(r.categoryId))
        errors.push({
          row: i + 2,
          field: 'categoryId',
          message: 'Category must exist and be active',
        });
    });
    if (errors.length)
      return {
        id: null,
        status: 'INVALID',
        total: rows.length,
        errors,
        preview: rows.slice(0, 20),
      };
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR UPDATE`;
      const outstanding = await tx.assetImport.count({
        where: {
          ownerId: user.id,
          status: { in: ['DRAFT', 'PENDING', 'QUEUED'] },
        },
      });
      if (outstanding >= 20)
        throw new BadRequestException(
          'Cancel unfinished imports before creating more previews (maximum 20)',
        );
      return tx.assetImport.create({
        data: {
          ownerId: user.id,
          total: rows.length,
          rows: JSON.parse(JSON.stringify(rows)) as Prisma.InputJsonValue,
          traceparent: captureTraceparent(),
        },
      });
    });
    return {
      id: row.id,
      status: row.status,
      total: row.total,
      errors: [],
      preview: rows.slice(0, 20),
    };
  }
  async get(id: string, user: AuthUser) {
    const row = await this.prisma.assetImport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Import not found');
    if (row.ownerId !== user.id && user.role !== Role.ADMIN)
      throw new ForbiddenException('This import belongs to another user');
    return {
      id: row.id,
      ownerId: row.ownerId,
      status: row.status,
      total: row.total,
      imported: row.imported,
      attempts: row.attempts,
      retryEpoch: row.retryEpoch,
      lastError: row.lastError,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }
  async list(user: AuthUser) {
    return this.prisma.assetImport.findMany({
      where: user.role === Role.ADMIN ? {} : { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        status: true,
        total: true,
        imported: true,
        attempts: true,
        lastError: true,
        createdAt: true,
      },
    });
  }
  async transition(
    id: string,
    user: AuthUser,
    action: 'confirm' | 'cancel' | 'retry',
  ) {
    if (action !== 'cancel' && process.env.JOBS_ENABLED !== 'true')
      throw new ServiceUnavailableException(
        'Background imports require JOBS_ENABLED=true and the jobs worker',
      );
    await this.get(id, user);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AssetImport" WHERE id=${id} FOR UPDATE`;
      const row = await tx.assetImport.findUniqueOrThrow({ where: { id } });
      if (
        action === 'confirm' &&
        ['PENDING', 'QUEUED', 'DONE'].includes(row.status)
      )
        return { id, status: row.status };
      if (
        action === 'confirm' &&
        row.createdAt.getTime() < Date.now() - 86400000
      )
        throw new BadRequestException(
          'Preview expired; validate the CSV again',
        );
      const allowed =
        action === 'confirm'
          ? ['DRAFT']
          : action === 'retry'
            ? ['FAILED']
            : ['DRAFT', 'PENDING', 'QUEUED'];
      if (!allowed.includes(row.status))
        throw new ConflictException('Import cannot make this transition');
      const status = action === 'cancel' ? 'CANCELLED' : 'PENDING';
      await tx.assetImport.update({
        where: { id },
        data: {
          status,
          leaseUntil: null,
          lastError: null,
          ...(action === 'retry'
            ? { retryEpoch: { increment: 1 }, attempts: 0 }
            : {}),
        },
      });
      await this.activity.log(
        {
          actorId: user.id,
          action: `asset.import_${action}`,
          entityType: 'AssetImport',
          entityId: id,
        },
        tx,
      );
      return { id, status };
    });
  }
}
