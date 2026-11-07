import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { RecordStatus, Role } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { PrismaService } from '../prisma/prisma.service';

/** The shape signed into the token. */
interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  /**
   * The user's `tokenVersion` when the token was minted.
   *
   * Optional in the type because tokens issued before this claim existed are
   * still in circulation; they are treated as version `0`, which is the
   * default every existing row got in the migration.
   */
  ver?: number;
}

/** What ends up on `req.user` after a valid token. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  departmentId: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'dev-secret',
    });
  }

  /**
   * Re-loads the user each request so deactivations / role changes take effect
   * immediately — and so a credential change can revoke tokens.
   *
   * There is no session table: a token is valid while its `ver` claim equals
   * the account's `tokenVersion`. Changing the password or pressing "sign out
   * everywhere" increments the column, which invalidates every token minted
   * up to that moment, on every device, without any extra storage.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || user.status === RecordStatus.INACTIVE) {
      throw new UnauthorizedException();
    }
    if ((payload.ver ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException();
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      departmentId: user.departmentId,
    };
  }
}
