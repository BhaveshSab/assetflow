import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

import { PASSWORD_MAX_LENGTH } from '../../common/security/password';

/**
 * Body for POST /org/employees (ADMIN) — provision an account directly from
 * the Employee Directory without requiring the person to self-signup first.
 */
export class CreateEmployeeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsEmail()
  @MaxLength(254)
  email: string;

  /**
   * Optional initial password. When omitted the API generates a strong
   * temporary one and returns it **once** in the response.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  /** Defaults to EMPLOYEE. Only an Admin can set this here anyway. */
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
