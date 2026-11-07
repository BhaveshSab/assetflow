import { IsEmail, MaxLength } from 'class-validator';

/**
 * Body for `POST /auth/forgot-password`.
 *
 * The response is identical whether or not the address exists, so this DTO
 * carries no hint about accounts — it is only a mailbox.
 */
export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(254)
  email: string;
}
