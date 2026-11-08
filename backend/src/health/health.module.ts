import { Module } from '@nestjs/common';

import { DatabaseReadinessService } from './database-readiness.service';
import { HealthController } from './health.controller';
import { PrismaModule } from '../prisma/prisma.module';

/** Public health endpoint (`GET /api/health`). */
@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [DatabaseReadinessService],
})
export class HealthModule {}
