import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RecordStatus, Role, User } from '@prisma/client';
import { randomBytes } from 'crypto';
import { OAuth2Client, TokenPayload } from 'google-auth-library';

import { ActivityService } from '../activity/activity.service';
import { normalizeEmail } from '../common/security/email';
import { hashPassword, verifyPassword } from '../common/security/password';
import {
  RESET_TOKEN_TTL_MINUTES,
  hashResetToken,
  isExpired,
  issueResetToken,
  resetUrl,
} from '../common/security/reset-token';
import { MAILER } from '../mail/mailer.interface';
import type { Mailer } from '../mail/mailer.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AuthThrottleService } from './auth-throttle.service';

/** The public-safe view of a user (never leaks passwordHash). */
export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: RecordStatus;
  departmentId: string | null;
  avatarUrl: string | null;
  credentialsChangedAt: Date | null;
};

/**
 * Cache of the "no such account" hash, one per bcrypt cost.
 *
 * When the e-mail does not exist, a hash is compared anyway so the request
 * costs the same as a real one. The hash is generated at the *configured*
 * cost: a hard-coded cost-10 constant would make an unknown address cheaper to
 * reject than a real one once `BCRYPT_ROUNDS` is 12, which is the timing
 * signal this exists to remove.
 */
const equalizerHashes = new Map<number, string>();

/**
 * One message for every failing reset attempt.
 *
 * An expired token, a reused token and a token that never existed are
 * indistinguishable on purpose: there is nothing useful for the caller to
 * learn from the difference, and the person who *does* hold a broken link is
 * told to request a new one either way.
 */
const INVALID_RESET_TOKEN =
  'This reset link is invalid or has expired. Request a new one.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly throttle: AuthThrottleService,
    private readonly activity: ActivityService,
    @Inject(MAILER) private readonly mail: Mailer,
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
      user?.passwordHash ?? (await this.timingEqualizerHash()),
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

  // ---------------------------------------------------------------------
  // Password reset — "forgot password"
  // ---------------------------------------------------------------------

  /**
   * Start a password reset.
   *
   * Returns nothing and never says whether the address is real. The caller
   * (the controller) answers `202` with a fixed sentence, so the endpoint
   * cannot be used to enumerate accounts — the same rule the sign-in endpoint
   * already follows.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        passwordHash: true,
      },
    });

    // A missing account, a deactivated one, and a Google-only account (which
    // has no password to reset) all take the empty path. No mail, no row.
    if (!user || user.status === RecordStatus.INACTIVE || !user.passwordHash) {
      return;
    }

    const issued = issueResetToken();

    // One transaction: the previous links stop working at the same moment the
    // new one starts, so a forwarded old e-mail cannot be replayed later.
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: issued.hash,
          expiresAt: issued.expiresAt,
        },
      });
      // The audit row is written on the *same* connection as the mutation:
      // either both land or neither does.
      await this.activity.log(
        {
          actorId: null,
          action: 'user.password_reset_requested',
          entityType: 'User',
          entityId: user.id,
        },
        tx,
      );
    });

    await this.sendResetMail(user.email, user.name, issued.token);
  }

  /** Complete a reset with the token from the e-mail. */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(dto.token) },
    });
    if (!record || record.usedAt || isExpired(record.expiresAt)) {
      throw new BadRequestException(INVALID_RESET_TOKEN);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user || user.status === RecordStatus.INACTIVE) {
      throw new BadRequestException(INVALID_RESET_TOKEN);
    }

    const passwordHash = await hashPassword(dto.password, {
      rounds: this.bcryptRounds(),
    });
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Claim the token conditionally: two requests arriving with the same
      // link must not both succeed. `updateMany` with `usedAt: null` is the
      // compare-and-set — the loser sees `count === 0`.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException(INVALID_RESET_TOKEN);
      }

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 }, // every other session is signed out
          credentialsChangedAt: now,
        },
      });

      // Delete the row that was just spent (and any sibling that somehow
      // survived): an empty table means a stolen database dump contains no
      // leftover link, spent or otherwise.
      await tx.passwordResetToken.deleteMany({
        where: { userId: user.id },
      });

      await this.activity.log(
        {
          actorId: null,
          action: 'user.password_reset_completed',
          entityType: 'User',
          entityId: user.id,
        },
        tx,
      );
    });

    await this.sendPasswordChangedMail(user.email, user.name);
  }

  // ---------------------------------------------------------------------
  // Signed-in account management
  // ---------------------------------------------------------------------

  /**
   * Change the password of the signed-in user.
   *
   * Returns a **fresh token** for the caller: the version bump that signs out
   * every other device also invalidates the token that made this request, and
   * a user should not be logged out of the tab they just used.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<{ token: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    if (!user.passwordHash) {
      throw new BadRequestException(
        'This account signs in with Google. Use "Forgot password" to set a password first.',
      );
    }

    const currentMatches = await verifyPassword(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!currentMatches) {
      throw new BadRequestException('The current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'The new password must be different from the current one',
      );
    }

    const passwordHash = await hashPassword(dto.newPassword, {
      rounds: this.bcryptRounds(),
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
          credentialsChangedAt: new Date(),
        },
      });
      await this.activity.log(
        {
          actorId: user.id,
          action: 'user.password_changed',
          entityType: 'User',
          entityId: user.id,
        },
        tx,
      );
      return row;
    });

    await this.sendPasswordChangedMail(user.email, user.name);

    return {
      token: this.jwt.sign({
        sub: updated.id,
        email: updated.email,
        role: updated.role,
        ver: updated.tokenVersion,
      }),
    };
  }

  /** The signed-in user editing their own name / avatar. */
  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<PublicUser> {
    const data: Prisma.UserUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.length < 2) {
        throw new BadRequestException('The name is too short');
      }
      data.name = name;
    }
    // `null` clears the picture; `undefined` (absent) leaves it alone.
    if (dto.avatarUrl !== undefined) {
      data.avatarUrl = dto.avatarUrl;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({ where: { id: userId }, data });
      await this.activity.log(
        {
          actorId: userId,
          action: 'user.profile_updated',
          entityType: 'User',
          entityId: userId,
          metadata: {
            fields: Object.keys(data),
            // Never log the URL itself: it can contain a personal identifier.
            avatarSet: row.avatarUrl !== null,
          },
        },
        tx,
      );
      return row;
    });

    return this.toPublicUser(user);
  }

  /**
   * Sign out of every device.
   *
   * Bumping `tokenVersion` is the whole mechanism: every token minted before
   * this call carries an older `ver` and is rejected by `JwtStrategy` on its
   * next request. The caller's own token dies too, which is the point.
   */
  async logoutEverywhere(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      });
      await this.activity.log(
        {
          actorId: userId,
          action: 'user.signed_out_everywhere',
          entityType: 'User',
          entityId: userId,
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /**
   * Send the reset link.
   *
   * A mail failure is logged, never surfaced: the response is the same `202`
   * for every address, and a caller must not learn from a 500 that this one
   * exists. The user can ask again.
   */
  private async sendResetMail(
    to: string,
    name: string,
    token: string,
  ): Promise<void> {
    try {
      await this.mail.sendPasswordReset({
        to,
        name,
        resetUrl: resetUrl(this.frontendUrl(), token),
        expiresMinutes: RESET_TOKEN_TTL_MINUTES,
      });
    } catch (error) {
      this.logger.error(
        `could not send the reset mail: ${(error as Error).message}`,
      );
    }
  }

  private async sendPasswordChangedMail(
    to: string,
    name: string,
  ): Promise<void> {
    try {
      await this.mail.sendPasswordChanged({ to, name });
    } catch (error) {
      this.logger.warn(
        `could not send the password-changed notice: ${(error as Error).message}`,
      );
    }
  }

  private buildAuthResponse(user: User) {
    const publicUser = this.toPublicUser(user);
    const token = this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
      // Which "generation" of credentials this token belongs to. Bumping the
      // column (password change, "sign out everywhere") invalidates it.
      ver: user.tokenVersion,
    });
    return { token, user: publicUser };
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      departmentId: user.departmentId,
      avatarUrl: user.avatarUrl,
      credentialsChangedAt: user.credentialsChangedAt,
    };
  }

  /**
   * A bcrypt hash of a random value, at the configured cost, computed once and
   * cached. Nothing can match it (the plaintext is discarded), it only exists
   * to spend the same time as a real comparison.
   */
  private async timingEqualizerHash(): Promise<string> {
    const rounds = this.bcryptRounds();
    const cached = equalizerHashes.get(rounds);
    if (cached) return cached;

    const hash = await hashPassword(randomBytes(32).toString('hex'), {
      rounds,
    });
    equalizerHashes.set(rounds, hash);
    return hash;
  }

  private bcryptRounds(): number {
    return this.config.get<number>('BCRYPT_ROUNDS') ?? 12;
  }

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL')?.trim() || 'http://localhost:5173'
    );
  }

  private googleClientId(): string | null {
    return this.config.get<string>('GOOGLE_CLIENT_ID')?.trim() || null;
  }
}
