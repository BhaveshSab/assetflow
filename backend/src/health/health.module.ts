import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { PrismaModule } from '../prisma/prisma.module';

/** Public health endpoint (`GET /api/health`). */
@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class HealthModule {}
