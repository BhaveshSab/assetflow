import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { LoginThrottleService } from './login-throttle.service';

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
  providers: [AuthService, JwtStrategy, LoginThrottleService],
  exports: [AuthService],
})
export class AuthModule {}
