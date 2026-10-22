import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RecordStatus, Role, User } from '@prisma/client';

import { normalizeEmail } from '../common/security/email';
import { hashPassword, verifyPassword } from '../common/security/password';
import { PrismaService } from '../prisma/prisma.service';
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

  async login(dto: LoginDto, clientIp = 'unknown') {
    const email = normalizeEmail(dto.email);
    const throttleKey = `${email}|${clientIp}`;

    // Refuse early when this account/IP pair is currently blocked.
    this.throttle.assertNotBlocked(throttleKey);

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
      this.throttle.recordFailure(throttleKey);
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.status === RecordStatus.INACTIVE) {
      this.throttle.recordFailure(throttleKey);
      throw new UnauthorizedException('This account is deactivated');
    }

    this.throttle.recordSuccess(throttleKey);
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
}
