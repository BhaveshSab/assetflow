import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Body for `PATCH /auth/me` — the user editing their own account.
 *
 * Only two fields: the name and the picture. Role, status, department and
 * e-mail are deliberately absent, so a crafted request cannot reach them —
 * and the global `forbidNonWhitelisted` pipe rejects one that tries.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  /**
   * `https://…`, or `null` to remove the picture.
   *
   * `http:` is rejected (mixed content, and the image would travel in clear
   * text) and so is every non-http scheme — `javascript:` above all, which
   * would otherwise be a stored XSS the moment it is put in an `<img src>`.
   */
  @IsOptional()
  @ValidateIf((o: UpdateProfileDto) => o.avatarUrl !== null)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  @MaxLength(2048)
  avatarUrl?: string | null;
}
