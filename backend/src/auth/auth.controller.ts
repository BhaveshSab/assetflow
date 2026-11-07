import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { normalizeEmail } from '../common/security/email';
import { AuthService } from './auth.service';
import { AuthThrottleService } from './auth-throttle.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import type { AuthUser } from './jwt.strategy';

/**
 * Authentication and self-service account management.
 *
 * The global bucket (300 requests a minute per IP, see AppModule) is a
 * backstop against scrapers. It is far too loose for the endpoints below,
 * which create accounts, send e-mail or check a secret, so each one spends a
 * counter of its own in {@link AuthThrottleService}:
 *
 *   signup           `signup:<ip>`             10 / 15 min
 *   forgot-password  `reset:<email>|<ip>`      10 / 15 min
 *   reset-password   `reset-token:<ip>`        10 / 15 min
 *   change-password  `change:<userId>`         10 / 15 min
 *   login            `login:<email>|<ip>`      10 / 15 min, cleared on success
 *
 * Those counters are keyed per account (not only per IP) where that matters,
 * because a whole campus can share one address — a per-IP limit alone would
 * either be useless or punish everybody behind the same router. The numbers
 * come from `AUTH_THROTTLE_LIMIT` / `AUTH_THROTTLE_TTL`, so they are tunable
 * per deployment and lowerable in a test.
 *
 * `google` keeps its plain `@Throttle`: it is a single high-volume exchange
 * and there is no per-account key to use before the token is verified.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly throttle: AuthThrottleService,
  ) {}

  /** Create an Employee account and return a token. */
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Ip() clientIp: string) {
    const key = `signup:${clientIp}`;
    await this.throttle.assertNotBlocked(
      key,
      'Too many accounts created from this address',
    );
    // Counted before the work, so a flood of "email already exists" responses
    // spends the budget exactly like a flood of successful ones.
    await this.throttle.recordAttempt(key);
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

  /** Edit your own name / profile picture. */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user.id, dto);
  }

  /**
   * Ask for a reset link.
   *
   * `202 Accepted` with a fixed body, always — the endpoint must not reveal
   * whether an address has an account. The work (token + e-mail) happens
   * inside, and a missing address simply does nothing.
   */
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Ip() clientIp: string) {
    // Keyed by address *and* client, so one mailbox cannot be flooded from a
    // single machine, and one office's shared IP cannot block the rest of the
    // office from resetting a different account.
    const key = `reset:${normalizeEmail(dto.email)}|${clientIp}`;
    await this.throttle.assertNotBlocked(key, 'Too many reset requests');
    await this.throttle.recordAttempt(key);

    await this.auth.forgotPassword(dto);
    return {
      message:
        'If an account exists for that address, a reset link is on its way.',
    };
  }

  /** Finish the reset with the token from the e-mail. */
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto, @Ip() clientIp: string) {
    // A 256-bit token cannot be guessed, but an unlimited endpoint is still an
    // invitation to try, and the database lookup behind it is not free.
    const key = `reset-token:${clientIp}`;
    await this.throttle.assertNotBlocked(key, 'Too many reset attempts');
    await this.throttle.recordAttempt(key);

    await this.auth.resetPassword(dto);
    return { message: 'Your password has been changed. You can sign in now.' };
  }

  /** Change the password of the signed-in user; returns a fresh token. */
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    const key = `change:${user.id}`;
    await this.throttle.assertNotBlocked(key, 'Too many password changes');
    await this.throttle.recordAttempt(key);
    return this.auth.changePassword(user.id, dto);
  }

  /** Invalidate every token issued so far, including the caller's own. */
  @Post('logout-everywhere')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logoutEverywhere(@CurrentUser() user: AuthUser) {
    await this.auth.logoutEverywhere(user.id);
    return {
      message: 'Every device has been signed out. Please sign in again.',
    };
  }
}
