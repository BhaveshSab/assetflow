import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { RedisService } from '../common/redis/redis.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import {
  InMemoryLoginAttemptStore,
  RedisLoginAttemptStore,
} from './login-throttle.store';
import {
  LOGIN_ATTEMPT_STORE,
  LoginThrottleService,
} from './login-throttle.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        ({
          secret: config.get<string>('JWT_SECRET') ?? 'dev-secret',
          // `as JwtModuleOptions` — the lib types expiresIn as a template
          // literal ("7d" | 3600 | ...); a plain env string needs the cast.
          signOptions: {
            expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '7d',
          },
        }) as JwtModuleOptions,
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    LoginThrottleService,
    {
      // The sign-in counters live in Redis when `REDIS_URL` is configured
      // (shared by every instance, survives a restart); otherwise they stay
      // in the process, exactly as before.
      provide: LOGIN_ATTEMPT_STORE,
      useFactory: (redis: RedisService) =>
        redis.enabled
          ? new RedisLoginAttemptStore(redis)
          : new InMemoryLoginAttemptStore(),
      inject: [RedisService],
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
