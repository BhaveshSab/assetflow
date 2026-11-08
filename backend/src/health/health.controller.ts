import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';

import { SkipStartupCheck } from '../common/decorators/skip-startup-check.decorator';
import { RedisService } from '../common/redis/redis.service';
import { startupStatus } from '../config/startup-status';
import type { Response } from 'express';
import { DatabaseReadinessService } from './database-readiness.service';

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
    private readonly databaseReadiness: DatabaseReadinessService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness + readiness in one document. */
  @Get()
  @SkipStartupCheck()
  @HttpCode(200)
  async check() {
    const startupError = startupStatus.getError();

    const { database, schema } = await this.databaseReadiness.check();
    const databaseError =
      database === 'down'
        ? 'Database is temporarily unavailable.'
        : schema === 'outdated'
          ? 'Database migrations or schema permissions require attention.'
          : null;

    const ok = !startupError && database === 'up' && schema === 'current';
    return {
      status: ok ? 'ok' : 'degraded',
      database,
      schema,
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
  async ready(@Res({ passthrough: true }) response: Response) {
    const startupError = startupStatus.getError();

    const { database, schema } = await this.databaseReadiness.check();
    const ready = !startupError && database === 'up' && schema === 'current';
    const databaseError =
      database === 'down'
        ? 'Database is temporarily unavailable.'
        : schema === 'outdated'
          ? 'Database migrations or schema permissions require attention.'
          : null;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ready ? 'ready' : 'not-ready',
      database,
      schema,
      ...(databaseError ? { databaseError } : {}),
      ...(startupError ? { startupError } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
