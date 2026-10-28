import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for POST /auth/google.
 *
 * `credential` is the ID token returned by Google Identity Services in the
 * browser. It is verified server-side against Google's public keys — the
 * browser never gets to assert who the user is.
 */
export class GoogleLoginDto {
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  credential: string;
}
