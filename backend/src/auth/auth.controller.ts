import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import type { AuthUser } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Create an Employee account and return a token. */
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  /**
   * Public configuration for the sign-in page: whether Google is available.
   * The client id is public (the browser must know it); the secret is not
   * needed for the ID-token flow.
   */
  @Get('config')
  config() {
    return this.auth.providerConfig();
  }

  /** Exchange email + password for a token. */
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Ip() clientIp: string) {
    return this.auth.login(dto, clientIp);
  }

  /** Exchange a Google ID token for an AssetFlow token. */
  @Post('google')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  google(@Body() dto: GoogleLoginDto) {
    return this.auth.googleLogin(dto);
  }

  /** Return the currently logged-in user (requires a valid token). */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}
