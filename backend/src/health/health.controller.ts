import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

import { SkipStartupCheck } from '../common/decorators/skip-startup-check.decorator';
import { RedisService } from '../common/redis/redis.service';
import { startupStatus } from '../config/startup-status';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Public health endpoints — `GET /api/health` and `GET /api/health/ready`.
 *
 * They answer even when the environment is broken (that is the whole point):
 * the body tells you whether the configuration is valid, whether Postgres is
 * reachable and whether the shared rate-limit store is available — so a
 * deployment problem can be diagnosed without a login.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness + readiness in one document. */
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
      // Where the rate-limit counters live: `redis` = shared by every
      // instance, `memory` = per process.
      rateLimitStore: this.redis.enabled ? 'redis' : 'memory',
      redis: this.redis.enabled
        ? this.redis.degraded
          ? 'down'
          : 'up'
        : 'disabled',
      ...(databaseError ? { databaseError } : {}),
      ...(startupError ? { startupError } : {}),
      ...(this.redis.degraded && this.redis.error
        ? { redisError: this.redis.error }
        : {}),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness — the probe Docker/Kubernetes uses to decide whether the
   * container may receive traffic. A database that cannot be reached means
   * the API cannot serve a single useful request → `503`.
   */
  @Get('ready')
  @SkipStartupCheck()
  @HttpCode(HttpStatus.OK)
  async ready() {
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

    const ready = !startupError && database === 'up';
    return {
      status: ready ? 'ready' : 'not-ready',
      database,
      ...(databaseError ? { databaseError } : {}),
      ...(startupError ? { startupError } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
