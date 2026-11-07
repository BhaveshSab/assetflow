import { IsString, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../../common/security/password';

/**
 * Body for `POST /auth/change-password` (signed-in user).
 *
 * The current password is required even though the caller already holds a
 * token: a stolen laptop with an open tab must not be enough to lock the real
 * owner out of their account.
 */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}
