import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RecordStatus, Role, User } from '@prisma/client';
import { OAuth2Client, TokenPayload } from 'google-auth-library';

import { normalizeEmail } from '../common/security/email';
import { hashPassword, verifyPassword } from '../common/security/password';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { LoginThrottleService } from './login-throttle.service';
import { SignupDto } from './dto/signup.dto';

/** The public-safe view of a user (never leaks passwordHash). */
export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  departmentId: string | null;
};

/**
 * A pre-computed bcrypt hash of a throw-away value. It is compared against
 * when the e-mail does not exist, so a failed sign-in costs the same amount of
 * time whether or not the account is real (no user enumeration by timing).
 */
const TIMING_EQUALIZER_HASH =
  '$2b$10$jWl8m5xNdRFlXlK4AcU1kuRuONp11gwyLA6yPvOvjbwANi8fJqgb2';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly throttle: LoginThrottleService,
  ) {}

  /** Signup ALWAYS creates an EMPLOYEE — roles are only granted later by an Admin. */
  async signup(dto: SignupDto) {
    const email = normalizeEmail(dto.email);

    // Case-insensitive duplicate check — otherwise "Admin@x.com" and
    // "admin@x.com" would create two accounts for the same person.
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await hashPassword(dto.password, {
      rounds: this.bcryptRounds(),
    });
    const user = await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        email,
        passwordHash,
        role: Role.EMPLOYEE, // hard-coded on purpose — cannot self-elevate
      },
    });

    return this.buildAuthResponse(user);
  }

  /**
   * Public configuration for the sign-in page.
   *
   * A Google OAuth **client id** is public by design — the browser needs it to
   * render the button. No client secret is involved: the browser receives an
   * ID token from Google and the API verifies that token here.
   */
  providerConfig(): { googleClientId: string | null } {
    return { googleClientId: this.googleClientId() };
  }

  /**
   * Exchange a Google Identity Services ID token for an AssetFlow JWT.
   *
   * The token is verified against Google's public keys (signature, issuer,
   * audience and expiry). Only then is the e-mail trusted. A Google identity
   * is linked to an existing password account with the same verified e-mail
   * on first use; otherwise a new EMPLOYEE account is created — exactly the
   * role a normal signup receives.
   */
  async googleLogin(dto: GoogleLoginDto) {
    const clientId = this.googleClientId();
    if (!clientId) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured on this server',
      );
    }

    let payload: TokenPayload | undefined;
    try {
      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({
        idToken: dto.credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch {
      // Never echo the verification error: it can contain token details.
      throw new UnauthorizedException(
        'Google sign-in failed. Please try again.',
      );
    }

    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new UnauthorizedException(
        'The Google account must have a verified email address',
      );
    }

    const email = normalizeEmail(payload.email);
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });

    if (existing) {
      if (existing.status === RecordStatus.INACTIVE) {
        throw new UnauthorizedException('This account is deactivated');
      }
      if (existing.googleId && existing.googleId !== payload.sub) {
        throw new UnauthorizedException(
          'This email is linked to a different Google account',
        );
      }

      // Link on first use. The e-mail was verified by Google, so this also
      // proves the person controls the mailbox of the existing account.
      const user = existing.googleId
        ? existing
        : await this.prisma.user.update({
            where: { id: existing.id },
            data: { googleId: payload.sub },
          });

      return this.buildAuthResponse(user);
    }

    const name = payload.name?.trim() || email.split('@')[0];
    const user = await this.prisma.user.create({
      data: {
        name,
        email,
        passwordHash: null,
        googleId: payload.sub,
        role: Role.EMPLOYEE, // same hard-coded role as a normal signup
      },
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto, clientIp = 'unknown') {
    const email = normalizeEmail(dto.email);
    const throttleKey = `${email}|${clientIp}`;

    // Refuse early when this account/IP pair is currently blocked.
    await this.throttle.assertNotBlocked(throttleKey);

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });

    // Always run a bcrypt comparison — even for an unknown account — so the
    // response time does not reveal whether the e-mail exists.
    const passwordMatches = await verifyPassword(
      dto.password,
      user?.passwordHash ?? TIMING_EQUALIZER_HASH,
    );

    // Same error whether the email is unknown or the password is wrong.
    if (!user || !passwordMatches) {
      await this.throttle.recordFailure(throttleKey);
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.status === RecordStatus.INACTIVE) {
      await this.throttle.recordFailure(throttleKey);
      throw new UnauthorizedException('This account is deactivated');
    }

    await this.throttle.recordSuccess(throttleKey);
    return this.buildAuthResponse(user);
  }

  /** Used by GET /auth/me to return the freshest user record. */
  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.toPublicUser(user);
  }

  private buildAuthResponse(user: User) {
    const publicUser = this.toPublicUser(user);
    const token = this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    return { token, user: publicUser };
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      departmentId: user.departmentId,
    };
  }

  private bcryptRounds(): number {
    return this.config.get<number>('BCRYPT_ROUNDS') ?? 12;
  }

  private googleClientId(): string | null {
    return this.config.get<string>('GOOGLE_CLIENT_ID')?.trim() || null;
  }
}
