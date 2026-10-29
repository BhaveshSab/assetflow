import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { ActivityModule } from './activity/activity.module';
import { AllocationsModule } from './allocations/allocations.module';
import { AssetsModule } from './assets/assets.module';
import { AuditsModule } from './audits/audits.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { StartupGuard } from './common/guards/startup.guard';
import { RequestContextMiddleware } from './common/http/request-context.middleware';
import { RedisModule } from './common/redis/redis.module';
import { RedisThrottlerStorage } from './common/rate-limit/redis-throttler.storage';
import { UserThrottlerGuard } from './common/rate-limit/user-throttler.guard';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { safeValidateEnv } from './config/env.validation';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MetricsModule } from './metrics/metrics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrgModule } from './org/org.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    // Loads .env, validates it and makes ConfigService available everywhere.
    // The validator never throws: an unusable variable is reported through
    // `startupStatus` (see StartupGuard + GET /api/health) instead of
    // killing the process during import.
    ConfigModule.forRoot({ isGlobal: true, validate: safeValidateEnv }),
    PrismaModule,
    // The optional shared store for the rate-limit counters (Redis).
    RedisModule,
    // Prometheus metrics (GET /api/metrics, disabled unless enabled).
    MetricsModule,
    // Global per-IP rate limiting. Configured through the environment so a
    // deployment (or the test-suite) can tune it without a code change.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (config: ConfigService, storage: RedisThrottlerStorage) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('THROTTLE_TTL') ?? 60_000,
            limit: config.get<number>('THROTTLE_LIMIT') ?? 300,
          },
        ],
        // The counters are shared through Redis when `REDIS_URL` is set;
        // the storage falls back to the in-process counters when it is not.
        storage,
      }),
    }),
    // Cross-cutting, @Global — available to every feature module.
    ActivityModule,
    NotificationsModule,
    AuthModule,
    // Feature modules.
    OrgModule, // #3 Organization setup
    AssetsModule, // #4 Asset registration & directory
    AllocationsModule, // #5 Allocation & transfer
    BookingsModule, // #6 Resource booking
    MaintenanceModule, // #7 Maintenance
    AuditsModule, // #8 Audit cycles
    ReportsModule, // #2 + #9 Dashboard & reports
    HealthModule, // public health endpoint (GET /api/health)
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered as a global guard so *every* route is rate limited — the
    // per-route JWT/RBAC guards still run afterwards.
    //
    // `UserThrottlerGuard` counts per authenticated user and falls back to the
    // client IP for anonymous requests: behind one NAT (or with a load test)
    // an IP-only bucket is shared by everybody, which is neither fair to users
    // nor measurable.
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    // …and a second global guard that turns an invalid environment into a
    // readable 503 instead of an unreadable crash.
    { provide: APP_GUARD, useClass: StartupGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every request gets an id, is measured and produces one JSON log line.
    consumer
      .apply(RequestContextMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
