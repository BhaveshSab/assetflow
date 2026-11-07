import { IsString, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../../common/security/password';

/** Body for `POST /auth/reset-password`. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}
