import { Controller, Get, HttpCode } from '@nestjs/common';

import { SkipStartupCheck } from '../common/decorators/skip-startup-check.decorator';
import { startupStatus } from '../config/startup-status';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Public health endpoint — `GET /api/health`.
 *
 * It answers even when the environment is broken (that is the whole point):
 * the body tells you whether the configuration is valid and whether Postgres
 * is reachable, so a deployment problem can be diagnosed without a login.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @SkipStartupCheck()
  @HttpCode(200)
  async check() {
    const startupError = startupStatus.getError();

    let database: 'up' | 'down' = 'down';
    let databaseError: string | null = null;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch (err) {
      databaseError =
        err instanceof Error ? err.message.split('\n')[0] : String(err);
    }

    const ok = !startupError && database === 'up';
    return {
      status: ok ? 'ok' : 'degraded',
      database,
      ...(databaseError ? { databaseError } : {}),
      ...(startupError ? { startupError } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
