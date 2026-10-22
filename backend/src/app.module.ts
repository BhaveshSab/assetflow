import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ActivityModule } from './activity/activity.module';
import { AllocationsModule } from './allocations/allocations.module';
import { AssetsModule } from './assets/assets.module';
import { AuditsModule } from './audits/audits.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { validateEnv } from './config/env.validation';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrgModule } from './org/org.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    // Loads .env, validates it and makes ConfigService available everywhere.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    // Global per-IP rate limiting. Configured through the environment so a
    // deployment (or the test-suite) can tune it without a code change.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: 'default',
          ttl: config.get<number>('THROTTLE_TTL') ?? 60_000,
          limit: config.get<number>('THROTTLE_LIMIT') ?? 300,
        },
      ],
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
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered as a global guard so *every* route is rate limited — the
    // per-route JWT/RBAC guards still run afterwards.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
