import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const [counts, failed] = await Promise.all([
      this.prisma.jobOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.jobOutbox.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          topic: true,
          attempts: true,
          lastError: true,
          createdAt: true,
        },
      }),
    ]);
    return { enabled: process.env.JOBS_ENABLED === 'true', counts, failed };
  }

  /** No Redis dependency: the publisher will pick up the new delivery epoch. */
  async retry(id: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.jobOutbox.updateMany({
        where: { id, status: 'FAILED' },
        data: {
          status: 'PENDING',
          attempts: 0,
          retryEpoch: { increment: 1 },
          lastError: null,
          leaseUntil: null,
        },
      });
      if (!changed.count) {
        if (!(await tx.jobOutbox.findUnique({ where: { id } })))
          throw new NotFoundException('Job not found');
        throw new ConflictException('Only failed jobs can be retried');
      }
      await tx.activityLog.create({
        data: {
          actorId,
          action: 'job.retried',
          entityType: 'JobOutbox',
          entityId: id,
        },
      });
      return { success: true };
    });
  }
}
